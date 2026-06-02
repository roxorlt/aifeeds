// PM2 守护配置。部署到 .cc 服务器后：
//   cd /www/wwwroot/ai-feeds.cc/server && pm2 start ecosystem.config.cjs && pm2 save
//
// secret 不写这里——由 relay 自己从 /etc/aifeeds/relay.env 读（config.mjs loadEnvFile）。
// 本文件只设非敏感的运行参数。

module.exports = {
  apps: [
    {
      name: 'aifeeds-cc-relay',
      script: 'relay.mjs',
      cwd: '/www/wwwroot/ai-feeds.cc/server',
      instances: 1,
      exec_mode: 'fork', // 单实例：code 去重 / 飞行态用进程内存（架构见 architecture.md §5b）
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      max_memory_restart: '150M',
      // 非敏感默认值；secret 走 /etc/aifeeds/relay.env
      env: {
        NODE_ENV: 'production',
        PORT: '3001',
      },
      out_file: '/var/log/aifeeds-cc-relay/out.log',
      error_file: '/var/log/aifeeds-cc-relay/err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },
  ],
};
