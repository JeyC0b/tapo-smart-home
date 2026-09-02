module.exports = {
  apps: [
    {
      name: 'tapo-heating-dev',
      cwd: '/data/tapo/app',
      script: 'npm',
      args: 'run dev -- --host 0.0.0.0 --port 3000',
      env: {
        NODE_ENV: 'development'
      },
      autorestart: true,
      watch: false
    }
  ]
};
