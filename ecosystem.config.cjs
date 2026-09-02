module.exports = {
  apps: [{
    name: 'biometric_server',
    script: 'src/server.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '300M',
    exp_backoff_restart_delay: 100,
    time: true,
  }],
};
