/**
 * Telegram‑бот для управления задачами.
 *
 * Команды:
 *  /start  — приветствие и помощь
 *  /help   — помощь
 *  /add Текст задачи
 *          → создаёт задачу на «сейчас + 1 час», напомнить за 15 мин, один раз
 *  /list   — список ближайших задач для этого чата
 *  /delete N
 *          → удалить N‑ю ближайшую задачу (по номеру из /list)
 *
 * Бот работает поверх API сервера tasks-ui:
 *  GET  /api/tasks
 *  POST /api/tasks  { tasks: [...] }
 *
 * Требуется переменная окружения TELEGRAM_BOT_TOKEN.
 */

const TelegramBot = require('node-telegram-bot-api');
const path = require('path');

// Берём переменные из .env, принудительно перекрывая то, что может прийти от pm2
try { require('dotenv').config({ override: true }); } catch (_) {}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TASKS_API_URL = process.env.TASKS_API_URL || 'http://localhost:3080/api/tasks';

if (!BOT_TOKEN) {
  // Без токена нет смысла продолжать.
  console.error('TELEGRAM_BOT_TOKEN не задан. Укажите его в .env и перезапустите бота.');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function log(...args) {
  console.log('[bot]', ...args);
}

function generateId() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2)
  );
}

function formatDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function loadTasks() {
  const res = await fetch(TASKS_API_URL);
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return Array.isArray(data.tasks) ? data.tasks : [];
}

async function saveTasks(tasks) {
  const res = await fetch(TASKS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tasks }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${text}`);
  }
}

function filterTasksForChat(tasks, chatId) {
  const idStr = String(chatId);
  return tasks.filter((t) => {
    if (!t.telegramTo) return false;
    return String(t.telegramTo)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(idStr);
  });
}

// /start и /help
const HELP_TEXT =
  'Привет! Я бот-напоминалка.\n\n' +
  'Команды:\n' +
  '/add ДД.MM.ГГГГ ЧЧ:ММ текст — создать задачу на указанную дату/время (напомню за 15 минут)\n' +
  '/list — показать список ближайших задач\n' +
  '/delete N — удалить задачу под номером N из списка /list\n\n' +
  'Пример:\n' +
  '/add 25.03.2026 10:00 созвон с клиентом';

bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  log('start from', chatId);
  await bot.sendMessage(chatId, HELP_TEXT);
});

bot.onText(/^\/help$/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, HELP_TEXT);
});

// /add ДД.MM.ГГГГ ЧЧ:ММ текст  ИЛИ  /add текст
bot.onText(/^\/add(?:\s+(.+))?$/s, async (msg, match) => {
  const chatId = msg.chat.id;
  const text = (match[1] || '').trim();
  if (!text) {
    await bot.sendMessage(
      chatId,
      'Использование:\n' +
        '/add ДД.MM.ГГГГ ЧЧ:ММ текст\n\n' +
        'Пример:\n' +
        '/add 25.03.2026 10:00 созвон с клиентом'
    );
    return;
  }

  try {
    const allTasks = await loadTasks();
    const now = new Date();

    let title = text;
    let eventTime;

    // Пытаемся разобрать формат: 25.03.2026 10:00 текст
    const m = text.match(
      /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})\s+(.+)$/
    );
    if (m) {
      const [_, dd, mm, yyyy, hh, min, rest] = m;
      const year = Number(yyyy);
      const month = Number(mm) - 1;
      const day = Number(dd);
      const hour = Number(hh);
      const minute = Number(min);
      const dt = new Date(year, month, day, hour, minute);
      if (Number.isNaN(dt.getTime())) {
        throw new Error('Не удалось разобрать дату/время. Проверь формат ДД.MM.ГГГГ ЧЧ:ММ.');
      }
      if (dt <= now) {
        throw new Error('Дата/время уже в прошлом. Укажи время в будущем.');
      }
      eventTime = dt;
      title = rest.trim();
    } else {
      // Старый формат: /add текст — ставим через час от текущего времени
      eventTime = new Date(now.getTime() + 60 * 60 * 1000);
    }

    const task = {
      id: generateId(),
      title,
      dateTime: eventTime.toISOString(),
      remindBeforeMinutes: 15,
      repeat: 'once',
      telegramTo: String(chatId),
      createdAt: now.toISOString(),
    };

    allTasks.push(task);
    await saveTasks(allTasks);

    await bot.sendMessage(
      chatId,
      'Задача создана ✅\n' +
        `Когда: ${formatDateTime(task.dateTime)}\n` +
        'Напомню за 15 минут до события.'
    );
  } catch (err) {
    log('add error', err);
    await bot.sendMessage(
      chatId,
      'Не получилось сохранить задачу. Попробуйте позже.\n' + String(err.message || err)
    );
  }
});

// /list
bot.onText(/^\/list$/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const allTasks = await loadTasks();
    const myTasks = filterTasksForChat(allTasks, chatId);
    if (!myTasks.length) {
      await bot.sendMessage(chatId, 'У тебя пока нет задач.');
      return;
    }
    const now = new Date();
    const sorted = [...myTasks].sort(
      (a, b) => new Date(a.dateTime) - new Date(b.dateTime)
    );
    const lines = sorted.slice(0, 20).map((t, idx) => {
      const num = idx + 1;
      const when = formatDateTime(t.dateTime);
      const past = new Date(t.dateTime) < now && t.repeat === 'once';
      const flag = past ? ' (прошло)' : '';
      return `${num}) ${when} — ${t.title}${flag}`;
    });
    await bot.sendMessage(
      chatId,
      'Твои задачи:\n\n' +
        lines.join('\n') +
        '\n\nЧтобы удалить: /delete N (номер из списка).'
    );
  } catch (err) {
    log('list error', err);
    await bot.sendMessage(
      chatId,
      'Не получилось получить список задач. Попробуйте позже.'
    );
  }
});

// /delete N
bot.onText(/^\/delete\s+(\d+)$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const n = parseInt(match[1], 10);
  if (!Number.isFinite(n) || n <= 0) {
    await bot.sendMessage(chatId, 'Номер задачи должен быть положительным числом.');
    return;
  }

  try {
    const allTasks = await loadTasks();
    const myTasks = filterTasksForChat(allTasks, chatId);
    if (!myTasks.length) {
      await bot.sendMessage(chatId, 'У тебя нет задач для удаления.');
      return;
    }
    const sorted = [...myTasks].sort(
      (a, b) => new Date(a.dateTime) - new Date(b.dateTime)
    );
    if (n > sorted.length) {
      await bot.sendMessage(
        chatId,
        `Нет задачи под номером ${n}. Введи /list, чтобы посмотреть номера.`
      );
      return;
    }
    const target = sorted[n - 1];
    const remaining = allTasks.filter((t) => t.id !== target.id);
    await saveTasks(remaining);
    await bot.sendMessage(
      chatId,
      `Удалил задачу №${n}:\n${formatDateTime(target.dateTime)} — ${target.title}`
    );
  } catch (err) {
    log('delete error', err);
    await bot.sendMessage(
      chatId,
      'Не получилось удалить задачу. Попробуйте позже.'
    );
  }
});

log('Telegram‑бот запущен. Ожидаю команды…');

