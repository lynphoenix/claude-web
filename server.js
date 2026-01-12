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

// 全局共享的终端会话
// 结构: { termId: { id, term, history } }
const terminals = {};
// 所有终端列表
const terminalList = [];
// 当前活动的终端（所有客户端共享）
let activeTermId = null;

// 终端历史记录最大缓存大小（字符数）
const MAX_HISTORY_SIZE = 100000; // 100KB

let termCounter = 0;

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

// 主页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 创建新的终端会话
function createTerminal(shell = 'bash', options = {}) {
  const termId = 'term_' + (++termCounter);

  // 根据操作系统选择默认shell
  const platform = os.platform();
  let defaultShell = shell;
  let shellArgs = [];

  if (platform === 'win32') {
    defaultShell = 'cmd.exe';
  } else if (platform === 'linux' || platform === 'darwin') {
    defaultShell = process.env.SHELL || '/bin/bash';
    // 以登录模式启动shell，加载完整环境变量（.bash_profile, .profile等）
    shellArgs = ['-l'];
  }

  // 创建PTY，确保加载用户环境
  const term = pty.spawn(defaultShell, shellArgs, {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd: process.env.HOME || process.cwd(),
    env: process.env,
    ...options
  });

  // 存储终端信息（包含历史记录）
  terminals[termId] = {
    id: termId,
    term: term,
    history: '' // 缓存终端输出历史
  };

  terminalList.push(termId);

  // 设置为活动终端
  activeTermId = termId;

  // 终端输出处理 - 广播给所有连接的客户端
  term.onData((data) => {
    const terminal = terminals[termId];
    if (terminal) {
      // 缓存输出历史
      terminal.history += data;
      if (terminal.history.length > MAX_HISTORY_SIZE) {
        terminal.history = terminal.history.slice(-MAX_HISTORY_SIZE);
      }

      // 广播给所有连接的客户端
      io.emit('terminal-output', { termId, data });
    }
  });

  // 终端退出处理
  term.onExit(({ exitCode, signal }) => {
    // 广播关闭事件给所有客户端
    io.emit('terminal-closed', { termId, exitCode, signal });

    // 从列表中移除
    const idx = terminalList.indexOf(termId);
    if (idx > -1) {
      terminalList.splice(idx, 1);
    }

    // 如果是活动终端，切换到其他终端
    if (activeTermId === termId) {
      activeTermId = terminalList.length > 0 ? terminalList[0] : null;
    }

    delete terminals[termId];
  });

  return termId;
}

// Socket.IO 连接处理
io.on('connection', (socket) => {
  const socketId = socket.id;
  console.log('Client connected:', socketId, 'Total clients:', io.sockets.sockets.size);

  // 检查是否已有终端
  if (terminalList.length > 0) {
    // 已有终端，发送给新连接的客户端
    terminalList.forEach(termId => {
      const terminal = terminals[termId];
      if (terminal) {
        socket.emit('terminal-created', { termId, isRestored: true });
        // 发送历史记录
        if (terminal.history) {
          socket.emit('terminal-history', { termId, history: terminal.history });
        }
      }
    });
    socket.emit('terminals-restored', {
      termIds: terminalList,
      active: activeTermId
    });
  } else {
    // 没有终端，创建默认终端
    const initialTermId = createTerminal();
    // 广播给所有客户端
    io.emit('terminal-created', { termId: initialTermId, isInitial: true });
  }

  // 创建新终端
  socket.on('create-terminal', (data) => {
    const { shell, options } = data || {};
    const termId = createTerminal(shell, options);
    // 广播给所有客户端
    io.emit('terminal-created', { termId });
  });

  // 切换终端（只影响当前客户端的显示）
  socket.on('switch-terminal', (data) => {
    const { termId } = data;
    // 更新全局活动终端
    if (activeTermId !== termId) {
      activeTermId = termId;
    }
    socket.emit('terminal-switched', { termId });
  });

  // 终端输入
  socket.on('terminal-input', (data) => {
    const { termId, input } = data;
    const terminal = terminals[termId];
    if (terminal) {
      terminal.term.write(input);
    }
  });

  // 调整终端大小（只影响当前客户端）
  socket.on('terminal-resize', (data) => {
    const { termId, cols, rows } = data;
    const terminal = terminals[termId];
    if (terminal) {
      terminal.term.resize(cols, rows);
    }
  });

  // 关闭终端
  socket.on('close-terminal', (data) => {
    const { termId } = data;
    const terminal = terminals[termId];
    if (terminal) {
      terminal.term.kill();
    }
  });

  // 获取终端列表
  socket.on('get-terminals', () => {
    socket.emit('terminals-list', {
      terminals: terminalList.map(id => ({
        id,
        isActive: id === activeTermId
      })),
      active: activeTermId
    });
  });

  // 断开连接 - 不关闭终端，保持运行
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socketId, 'Remaining clients:', io.sockets.sockets.size);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Web Terminal Server running on port ${PORT}`);
  console.log(`Access it at: http://0.0.0.0:${PORT}`);
});
