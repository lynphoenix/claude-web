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

// 存储所有终端会话（持久化）
// 结构: { termId: { id, term, userId } }
const terminals = {};
// 存储每个用户的终端列表
// 结构: { userId: [termId1, termId2, ...] }
const userTerminals = {};
// 当前活动的终端
// 结构: { socketId: currentTermId }
const activeTerminals = {};
// socket到user的映射
// 结构: { socketId: userId }
const socketToUser = {};
// user到当前socket的映射（用于发送终端输出）
// 结构: { userId: socketId }
const userToSocket = {};

let termCounter = 0;

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

// 主页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 创建新的终端会话
function createTerminal(userId, socket, shell = 'bash', options = {}) {
  const termId = 'term_' + (++termCounter);

  // 初始化用户终端列表
  if (!userTerminals[userId]) {
    userTerminals[userId] = [];
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

  // 存储终端信息（持久化）
  terminals[termId] = {
    id: termId,
    term: term,
    userId: userId
  };

  userTerminals[userId].push(termId);

  // 设置当前活动终端
  activeTerminals[socket.id] = termId;
  // 更新用户到socket的映射
  userToSocket[userId] = socket.id;

  // 终端输出处理
  term.onData((data) => {
    // 使用userToSocket映射找到当前socket
    const currentSocketId = userToSocket[userId];
    if (currentSocketId) {
      const targetSocket = io.sockets.sockets.get(currentSocketId);
      if (targetSocket) {
        targetSocket.emit('terminal-output', { termId, data });
      }
    }
  });

  // 终端退出处理
  term.onExit(({ exitCode, signal }) => {
    // 找到该用户当前连接的socket并发送关闭事件
    const currentSocketId = userToSocket[userId];
    if (currentSocketId) {
      const targetSocket = io.sockets.sockets.get(currentSocketId);
      if (targetSocket) {
        targetSocket.emit('terminal-closed', { termId, exitCode, signal });
      }
    }

    // 从用户列表中移除
    const idx = userTerminals[userId].indexOf(termId);
    if (idx > -1) {
      userTerminals[userId].splice(idx, 1);
    }

    delete terminals[termId];
  });

  return termId;
}

// Socket.IO 连接处理
io.on('connection', (socket) => {
  const socketId = socket.id;
  // 使用简单的用户ID（实际应用中应该用认证）
  const userId = 'user_' + (socket.handshake.query.userId || 'default');
  socketToUser[socketId] = userId;
  // 更新用户到socket的映射
  userToSocket[userId] = socketId;

  console.log('Client connected:', socketId, 'as user:', userId);

  // 检查用户是否已有终端
  const existingTerms = userTerminals[userId] || [];
  if (existingTerms.length > 0) {
    // 用户已有终端，恢复连接
    existingTerms.forEach(termId => {
      const terminal = terminals[termId];
      if (terminal) {
        socket.emit('terminal-created', { termId, isRestored: true });
      }
    });
    activeTerminals[socketId] = existingTerms[0];
    socket.emit('terminals-restored', {
      termIds: existingTerms,
      active: existingTerms[0]
    });
  } else {
    // 新用户，创建默认终端
    const initialTermId = createTerminal(userId, socket);
    socket.emit('terminal-created', { termId: initialTermId, isInitial: true });
  }

  // 创建新终端
  socket.on('create-terminal', (data) => {
    const { shell, options } = data || {};
    const termId = createTerminal(userId, socket, shell, options);
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
    if (terminal && terminal.userId === userId) {
      terminal.term.write(input);
    }
  });

  // 调整终端大小
  socket.on('terminal-resize', (data) => {
    const { termId, cols, rows } = data;
    const terminal = terminals[termId];
    if (terminal && terminal.userId === userId) {
      terminal.term.resize(cols, rows);
    }
  });

  // 关闭终端
  socket.on('close-terminal', (data) => {
    const { termId } = data;
    const terminal = terminals[termId];
    if (terminal && terminal.userId === userId) {
      terminal.term.kill();
    }
  });

  // 获取终端列表
  socket.on('get-terminals', () => {
    const terms = userTerminals[userId] || [];
    const activeTerm = activeTerminals[socketId];
    socket.emit('terminals-list', {
      terminals: terms.map(id => ({
        id,
        isActive: id === activeTerm
      })),
      active: activeTerm
    });
  });

  // 断开连接 - 不再关闭terminal，保持常驻
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socketId);
    const userId = socketToUser[socketId];
    // 清理映射
    delete socketToUser[socketId];
    delete activeTerminals[socketId];
    // 如果这个socket是该用户当前的socket，清理userToSocket
    if (userId && userToSocket[userId] === socketId) {
      delete userToSocket[userId];
    }
    // 不再关闭terminal，terminal会继续运行
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Web Terminal Server running on port ${PORT}`);
  console.log(`Access it at: http://0.0.0.0:${PORT}`);
});
