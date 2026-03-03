/**
 * Сервер: веб-интерфейс + API задач + планировщик уведомлений в Telegram.
 * Один процесс — всё в одном.
 *
 * Запуск: npm start  или  node server.js
 * Переменные окружения: см. .env.example (или создайте .env)
 */

const path = require('path');
const fs = require('fs');
const http = require('http');

try { require('dotenv').config(); } catch (_) {}

const PORT = parseInt(process.env.PORT || '3080', 10);
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
const HOOK_TOKEN = process.env.OPENCLAW_HOOK_TOKEN || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_TO = (process.env.OPENCLAW_TELEGRAM_TO || '').split(',').map(s => s.trim()).filter(Boolean);
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || '60000', 10);

const ROOT = path.resolve(__dirname);
const DATA_DIR = path.join(ROOT, 'data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const STATE_FILE = path.join(DATA_DIR, '.reminder-state.json');

// ——— Хранение задач ———
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadTasksFromFile() {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(TASKS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.tasks) ? data.tasks : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    console.error('Ошибка чтения задач:', e.message);
    return [];
  }
}

function saveTasksToFile(tasks) {
  ensureDataDir();
  fs.writeFileSync(TASKS_FILE, JSON.stringify({ version: 1, tasks, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
}

// ——— Планировщик напоминаний (логика из reminder-runner) ———
function addMinutes(d, minutes) {
  const out = new Date(d);
  out.setMinutes(out.getMinutes() + minutes);
  return out;
}
function addDays(d, days) {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}
function addMonths(d, months) {
  const out = new Date(d);
  out.setMonth(out.getMonth() + months);
  return out;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('Не удалось сохранить state:', err.message);
  }
}

function getNextReminderAt(task, state) {
  const base = new Date(task.dateTime);
  const remindAt = addMinutes(base, -(task.remindBeforeMinutes || 0));
  const now = new Date();
  const doneKey = `done:${task.id}`;
  if (state[doneKey]) return null;
  const key = `next:${task.id}`;
  const stored = state[key];
  if (stored) {
    const next = new Date(stored);
    if (next > now) return next;
  }
  if (task.repeat === 'once') return remindAt;
  if (remindAt > now) return remindAt;
  switch (task.repeat) {
    case 'daily': {
      let next = addDays(remindAt, 1);
      while (next <= now) next = addDays(next, 1);
      return next;
    }
    case 'weekly': {
      let next = addDays(remindAt, 7);
      while (next <= now) next = addDays(next, 7);
      return next;
    }
    case 'monthly': {
      let next = addMonths(remindAt, 1);
      while (next <= now) next = addMonths(next, 1);
      return next;
    }
    default:
      return null;
  }
}

function advanceNextReminder(task, state) {
  const base = new Date(task.dateTime);
  const remindAt = addMinutes(base, -(task.remindBeforeMinutes || 0));
  const key = `next:${task.id}`;
  const doneKey = `done:${task.id}`;
  const current = state[key] ? new Date(state[key]) : remindAt;
  switch (task.repeat) {
    case 'daily':
      state[key] = addDays(current, 1).toISOString();
      break;
    case 'weekly':
      state[key] = addDays(current, 7).toISOString();
      break;
    case 'monthly':
      state[key] = addMonths(current, 1).toISOString();
      break;
    default:
      state[doneKey] = true;
      delete state[key];
  }
}

async function sendNotification(task) {
  const message = `🔔 Напоминание: ${task.title}\nВремя: ${new Date(task.dateTime).toLocaleString('ru-RU')}`;
  const toList = (task.telegramTo && String(task.telegramTo).trim())
    ? String(task.telegramTo).split(',').map(s => s.trim()).filter(Boolean)
    : TELEGRAM_TO;
  const targets = toList.length ? toList : ['last'];

  // Предпочтительный путь: прямой вызов Telegram Bot API.
  // Это делает систему независимой от OpenClaw webhook и проще для сервера.
  if (TELEGRAM_BOT_TOKEN && targets.length && targets[0] !== 'last') {
    for (const to of targets) {
      try {
        const tgUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const res = await fetch(tgUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: String(to).trim(),
            text: message,
          }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || body.ok !== true) {
          console.error('[Reminder] Telegram API error', res.status, body || '');
        } else {
          console.log(`[Reminder] sent to chat ${String(to).trim()} task="${task.title}"`);
        }
      } catch (err) {
        console.error('[Reminder] Telegram send failed:', err.message);
      }
    }
    return;
  }

  // Fallback: отправка через OpenClaw hooks (если настроено).
  const url = `${GATEWAY_URL.replace(/\/$/, '')}/hooks/agent`;
  const headers = {
    'Content-Type': 'application/json',
    ...(HOOK_TOKEN && { Authorization: `Bearer ${HOOK_TOKEN}` }),
  };

  for (const to of targets) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message,
          deliver: true,
          channel: 'telegram',
          to: String(to).trim(),
          name: 'Reminder',
        }),
      });
      if (!res.ok) console.error('[Reminder] OpenClaw error', res.status, await res.text());
    } catch (err) {
      console.error('[Reminder] Send failed:', err.message);
    }
  }
}

async function runReminderCheck() {
  const tasks = loadTasksFromFile();
  if (!tasks.length) return;
  const state = loadState();
  const now = new Date();
  let changed = false;

  for (const task of tasks) {
    const nextAt = getNextReminderAt(task, state);
    if (!nextAt || nextAt > now) continue;
    if (TELEGRAM_TO.length || (task.telegramTo && String(task.telegramTo).trim())) {
      await sendNotification(task);
    } else {
      console.log('[Reminder]', now.toISOString(), task.title);
    }
    advanceNextReminder(task, state);
    changed = true;
  }
  if (changed) saveState(state);
}

// ——— HTTP сервер (статику + API) ———
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

function serveFile(filePath, res) {
  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    res.writeHead(404);
    res.end();
  });
  res.writeHead(200, { 'Content-Type': contentType });
  stream.pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // API
  if (pathname === '/api/tasks' && req.method === 'GET') {
    const tasks = loadTasksFromFile();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tasks }));
    return;
  }
  if (pathname === '/api/tasks' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const data = JSON.parse(body || '{}');
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      saveTasksToFile(tasks);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, tasks }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Статика: index.html по / и по /index.html, остальное по имени
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(ROOT, filePath.replace(/^\//, ''));
  if (!path.resolve(filePath).startsWith(ROOT)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end();
    return;
  }
  serveFile(filePath, res);
});

server.listen(PORT, () => {
  console.log('Сервер: http://localhost:' + PORT);
  console.log('Данные: ' + TASKS_FILE);
  if (TELEGRAM_BOT_TOKEN) {
    console.log('Режим уведомлений: Telegram Bot API');
  } else {
    console.log('Режим уведомлений: OpenClaw webhook fallback');
  }
  if (!HOOK_TOKEN && TELEGRAM_TO.length) console.warn('OPENCLAW_HOOK_TOKEN не задан — уведомления в Telegram не будут отправляться.');
  if (!TELEGRAM_TO.length && HOOK_TOKEN) console.warn('OPENCLAW_TELEGRAM_TO не задан — укажите Chat ID.');
});

// Планировщик
setInterval(runReminderCheck, CHECK_INTERVAL_MS);
runReminderCheck();
