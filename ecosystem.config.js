module.exports = {
  apps: [
    {
      name: 'llm-manager',
      script: 'dist/app.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,          // 崩溃自动重启
      restart_delay: 3000,        // 崩溃后延迟 3 秒再重启
      max_restarts: 10,           // 15 秒内最多重启 10 次
      min_uptime: 5000,           // 运行不足 5s 视为启动失败
      max_memory_restart: '500M', // 内存超过 500M 自动重启
      env: {
        NODE_ENV: 'production',
        PORT: 11888
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true
    }
  ]
};
