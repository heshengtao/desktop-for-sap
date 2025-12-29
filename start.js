// scripts/start.js
const { spawn } = require('child_process');
const path = require('path');

// 设置 NODE_ENV 为 development
process.env.NODE_ENV = 'development';

const platform = process.platform;
let cmd, args, options;

if (platform === 'win32') {
  // Windows: 先切换代码页为 UTF-8，再启动 electron
  cmd = 'cmd.exe';
  args = ['/c', 'chcp 65001 >nul && electron .'];
} else {
  // macOS / Linux: 直接运行 electron
  cmd = 'electron';
  args = ['.'];
}

options = {
  stdio: 'inherit',
  shell: false, // 非 Windows 不需要 shell；Windows 已用 cmd.exe
  env: process.env,
  cwd: process.cwd(),
};

const child = spawn(cmd, args, options);

child.on('exit', (code) => {
  process.exit(code);
});