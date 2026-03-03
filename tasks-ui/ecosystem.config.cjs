const path = require('path');
const dotenv = require('dotenv');

// Загружаем .env из этой папки, но не храним секреты в git.
dotenv.config({ path: path.join(__dirname, '.env'), override: true });

module.exports = {
  apps: [
    {
      name: 'assistent-web',
      script: './server.js',
      cwd: __dirname,
      autorestart: true,
      watch: false,
      env: {
        PORT: process.env.PORT || '3080',
        OPENCLAW_GATEWAY_URL: process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789',
        OPENCLAW_HOOK_TOKEN: process.env.OPENCLAW_HOOK_TOKEN || '',
        OPENCLAW_TELEGRAM_TO: process.env.OPENCLAW_TELEGRAM_TO || '',
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
        CHECK_INTERVAL_MS: process.env.CHECK_INTERVAL_MS || '60000',
      },
    },
    {
      name: 'assistent-bot',
      script: './telegram-bot.js',
      cwd: __dirname,
      autorestart: true,
      watch: false,
      env: {
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
        TASKS_API_URL: process.env.TASKS_API_URL || 'http://localhost:3080/api/tasks',
      },
    },
  ],
};

