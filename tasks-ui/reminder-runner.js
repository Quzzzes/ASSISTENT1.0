/**
 * Напоминания: читает tasks из JSON и отправляет уведомления в Telegram через OpenClaw webhook.
 *
 * Запуск:
 *   node reminder-runner.js
 *
 * Переменные окружения:
 *   OPENCLAW_GATEWAY_URL  — URL Gateway (по умолчанию http://127.0.0.1:18789)
 *   OPENCLAW_HOOK_TOKEN  — токен для POST /hooks/agent
 *   OPENCLAW_TELEGRAM_TO  — Telegram Chat ID получателя (один или несколько через запятую)
 *   TASKS_FILE            — путь к JSON с задачами (по умолчанию ./reminder-tasks.json)
 *   CHECK_INTERVAL_MS     — интервал проверки в мс (по умолчанию 60000 — раз в минуту)
 */

const fs = require('fs');
const path = require('path');

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
const HOOK_TOKEN = process.env.OPENCLAW_HOOK_TOKEN || '';
const TELEGRAM_TO = (process.env.OPENCLAW_TELEGRAM_TO || '').split(',').map(s => s.trim()).filter(Boolean);
const TASKS_FILE = path.resolve(process.env.TASKS_FILE || path.join(__dirname, 'reminder-tasks.json'));
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || '60000', 10);

// Файл, где храним последние срабатывания (чтобы не слать дважды и считать повторы)
const STATE_FILE = path.join(path.dirname(TASKS_FILE), '.reminder-runner-state.json');

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
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

function loadTasks() {
  try {
    const raw = fs.readFileSync(TASKS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.tasks) ? data.tasks : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.error('Ошибка чтения', TASKS_FILE, err.message);
    return [];
  }
}

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

/** Следующий момент напоминания для задачи (дата/время события минус "заранее"). */
function getNextReminderAt(task, state) {
  const base = new Date(task.dateTime);
  const remindAt = addMinutes(base, - (task.remindBeforeMinutes || 0));
  const now = new Date();

  const key = `next:${task.id}`;
  const stored = state[key];
  if (stored) {
    const next = new Date(stored);
    if (next > now) return next;
  }

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
      return null; // once, уже прошло
  }
}

function advanceNextReminder(task, state) {
  const base = new Date(task.dateTime);
  const remindAt = addMinutes(base, - (task.remindBeforeMinutes || 0));
  const key = `next:${task.id}`;
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
      delete state[key];
  }
}

async function sendNotification(task, chatIds) {
  const message = `🔔 Напоминание: ${task.title}\nВремя: ${new Date(task.dateTime).toLocaleString('ru-RU')}`;
  const url = `${GATEWAY_URL.replace(/\/$/, '')}/hooks/agent`;
  const headers = {
    'Content-Type': 'application/json',
    ...(HOOK_TOKEN && { Authorization: `Bearer ${HOOK_TOKEN}` }),
  };

  const toList = (task.telegramTo && String(task.telegramTo).trim())
    ? String(task.telegramTo).split(',').map(s => s.trim()).filter(Boolean)
    : chatIds;
  const targets = toList.length ? toList : ['last'];

  for (const to of targets) {
    const body = {
      message,
      deliver: true,
      channel: 'telegram',
      to: to.trim(),
      name: 'Reminder',
    };
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) console.error('OpenClaw hook error', res.status, await res.text());
    } catch (err) {
      console.error('Send failed:', err.message);
    }
  }
}

async function check() {
  const tasks = loadTasks();
  if (!tasks.length) return;

  const state = loadState();
  const now = new Date();
  let changed = false;

  for (const task of tasks) {
    const nextAt = getNextReminderAt(task, state);
    if (!nextAt) continue;
    if (nextAt > now) continue;

    // Напоминание due
    if (TELEGRAM_TO.length && HOOK_TOKEN) {
      await sendNotification(task, TELEGRAM_TO);
    } else {
      console.log('[Reminder]', new Date().toISOString(), task.title);
    }

    advanceNextReminder(task, state);
    changed = true;
  }

  if (changed) saveState(state);
}

function run() {
  if (!HOOK_TOKEN && TELEGRAM_TO.length) {
    console.warn('OPENCLAW_HOOK_TOKEN не задан — уведомления в Telegram отправляться не будут.');
  }
  if (!TELEGRAM_TO.length && HOOK_TOKEN) {
    console.warn('OPENCLAW_TELEGRAM_TO не задан — укажите Chat ID получателя.');
  }

  check();
  setInterval(check, CHECK_INTERVAL_MS);
  console.log('Reminder runner started. Tasks file:', TASKS_FILE, 'Check every', CHECK_INTERVAL_MS / 1000, 's');
}

run();
