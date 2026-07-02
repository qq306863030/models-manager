#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const command = process.argv[2];
// 优先使用当前工作目录，兼容全局安装和本地运行
const rootDir = fs.existsSync(path.join(process.cwd(), 'ecosystem.config.js'))
  ? process.cwd()
  : path.resolve(__dirname, '..');

function start() {
  console.log('🚀 Starting llm-manager server...');
  const pm2 = spawn('npx', ['pm2', 'start', 'ecosystem.config.js'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: true
  });
  pm2.on('error', (err) => {
    console.error('❌ Failed to start:', err);
    process.exit(1);
  });
}

function stop() {
  console.log('🛑 Stopping llm-manager server...');
  const pm2 = spawn('npx', ['pm2', 'stop', 'ecosystem.config.js'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: true
  });
  pm2.on('error', (err) => {
    console.error('❌ Failed to stop:', err);
    process.exit(1);
  });
}

function restart() {
  console.log('🔄 Restarting llm-manager server...');
  const pm2 = spawn('npx', ['pm2', 'restart', 'ecosystem.config.js'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: true
  });
  pm2.on('error', (err) => {
    console.error('❌ Failed to restart:', err);
    process.exit(1);
  });
}

function showHelp() {
  console.log(`
ai-server - LLM Manager Server CLI

Usage: ai-server <command>

Commands:
  start     Start the server
  stop      Stop the server
  restart   Restart the server
  status    Show server status
  logs      Show server logs

Examples:
  ai-server start
  ai-server stop
  ai-server restart
  `);
}

function status() {
  console.log('📊 Server status:');
  const pm2 = spawn('npx', ['pm2', 'status'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: true
  });
}

function logs() {
  console.log('📜 Server logs:');
  const pm2 = spawn('npx', ['pm2', 'logs', 'llm-manager'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: true
  });
}

switch (command) {
  case 'start':
    start();
    break;
  case 'stop':
    stop();
    break;
  case 'restart':
    restart();
    break;
  case 'status':
    status();
    break;
  case 'logs':
    logs();
    break;
  default:
    showHelp();
    process.exit(1);
}
