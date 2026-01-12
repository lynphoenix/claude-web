const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const pty = require('node-pty');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// 存储所有终端会话
// 结构: { socketId: { id, term, socket } }
const terminals = {};
// 存储每个socket的终端列表
// 结构: { socketId: [termId1, termId2, ...] }
const userTerminals = {};
// 当前活动的终端
// 结构: { socketId: currentTermId }
const activeTerminals = {};

let termCounter = 0;

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

// 主页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 创建新的终端会话
function createTerminal(socket, shell = 'bash', options = {}) {
  const termId = 'term_' + (++termCounter);
  const socketId = socket.id;

  // 初始化用户终端列表
  if (!userTerminals[socketId]) {
    userTerminals[socketId] = [];
  }

  // 根据操作系统选择默认shell
  const platform = os.platform();
  let defaultShell = shell;
  let shellArgs = [];

  if (platform === 'win32') {
    defaultShell = 'cmd.exe';
  } else if (platform === 'linux' || platform === 'darwin') {
    defaultShell = process.env.SHELL || '/bin/bash';
  }

  // 创建PTY
  const term = pty.spawn(defaultShell, shellArgs, {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd: process.env.HOME || process.cwd(),
    env: process.env,
    ...options
  });

  // 存储终端信息
  terminals[termId] = {
    id: termId,
    term: term,
    socket: socket,
    socketId: socketId
  };

  userTerminals[socketId].push(termId);

  // 设置当前活动终端
  activeTerminals[socketId] = termId;

  // 终端输出处理
  term.onData((data) => {
    socket.emit('terminal-output', { termId, data });
  });

  // 终端退出处理
  term.onExit(({ exitCode, signal }) => {
    socket.emit('terminal-closed', { termId, exitCode, signal });

    // 从用户列表中移除
    const idx = userTerminals[socketId].indexOf(termId);
    if (idx > -1) {
      userTerminals[socketId].splice(idx, 1);
    }

    // 如果是当前活动终端，切换到其他终端或清空
    if (activeTerminals[socketId] === termId) {
      if (userTerminals[socketId].length > 0) {
        activeTerminals[socketId] = userTerminals[socketId][0];
      } else {
        delete activeTerminals[socketId];
      }
    }

    delete terminals[termId];
  });

  return termId;
}

// Socket.IO 连接处理
io.on('connection', (socket) => {
  const socketId = socket.id;
  console.log('Client connected:', socketId);

  // 初始化时创建一个默认终端
  const initialTermId = createTerminal(socket);
  socket.emit('terminal-created', { termId: initialTermId, isInitial: true });

  // 创建新终端
  socket.on('create-terminal', (data) => {
    const { shell, options } = data || {};
    const termId = createTerminal(socket, shell, options);
    socket.emit('terminal-created', { termId });
  });

  // 切换终端
  socket.on('switch-terminal', (data) => {
    const { termId } = data;
    if (activeTerminals[socketId] !== termId) {
      activeTerminals[socketId] = termId;
      socket.emit('terminal-switched', { termId });
    }
  });

  // 终端输入
  socket.on('terminal-input', (data) => {
    const { termId, input } = data;
    const terminal = terminals[termId];
    if (terminal && terminal.socketId === socketId) {
      terminal.term.write(input);
    }
  });

  // 调整终端大小
  socket.on('terminal-resize', (data) => {
    const { termId, cols, rows } = data;
    const terminal = terminals[termId];
    if (terminal && terminal.socketId === socketId) {
      terminal.term.resize(cols, rows);
    }
  });

  // 关闭终端
  socket.on('close-terminal', (data) => {
    const { termId } = data;
    const terminal = terminals[termId];
    if (terminal && terminal.socketId === socketId) {
      terminal.term.kill();
    }
  });

  // 获取终端列表
  socket.on('get-terminals', () => {
    const terms = userTerminals[socketId] || [];
    const activeTerm = activeTerminals[socketId];
    socket.emit('terminals-list', {
      terminals: terms.map(id => ({
        id,
        isActive: id === activeTerm
      })),
      active: activeTerm
    });
  });

  // 断开连接
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socketId);

    // 关闭该用户的所有终端
    const terms = userTerminals[socketId] || [];
    terms.forEach(termId => {
      const terminal = terminals[termId];
      if (terminal) {
        terminal.term.kill();
        delete terminals[termId];
      }
    });

    delete userTerminals[socketId];
    delete activeTerminals[socketId];
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Web Terminal Server running on port ${PORT}`);
  console.log(`Access it at: http://0.0.0.0:${PORT}`);
});
