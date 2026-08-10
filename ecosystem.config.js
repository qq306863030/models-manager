module.exports = {
  apps: [
    {
      name: 'llm-manager',
      script: 'dist/app.js',
      interpreter: 'C:/Users/30686/.workbuddy/binaries/node/versions/22.22.2/node.exe',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 11888
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true
    }
  ]
};
