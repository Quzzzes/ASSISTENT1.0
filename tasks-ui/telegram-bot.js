/**
 * Telegram‑бот для управления задачами.
 *
 * Команды:
 *  /start  — приветствие и помощь
 *  /help   — помощь
 *  /add ...   — создать задачу
 *               Поддерживаются форматы:
 *               1) /add ДД.MM.ГГГГ ЧЧ:ММ текст
 *               2) /add ДД.MM.ГГГГ ЧЧ.ММ текст
 *               3) /add ЧЧ:ММ текст              (сегодня/завтра)
 *               4) /add текст                    (через 1 час)
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

// Берём переменные именно из .env рядом со скриптом, перекрывая окружение pm2
try {
  require('dotenv').config({
    path: path.join(__dirname, '.env'),
    override: true,
  });
} catch (_) {}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TASKS_API_URL = process.env.TASKS_API_URL || 'http://localhost:3080/api/tasks';
const BOT_TZ = process.env.APP_TZ || process.env.TZ || 'Europe/Moscow';
const DEFAULT_REMIND_BEFORE_MINUTES = Number.isFinite(Number(process.env.DEFAULT_REMIND_BEFORE_MINUTES))
  ? Math.max(0, Number(process.env.DEFAULT_REMIND_BEFORE_MINUTES))
  : 0;

if (!BOT_TOKEN) {
  // Без токена нет смысла продолжать.
  console.error('TELEGRAM_BOT_TOKEN не задан. Укажите его в .env и перезапустите бота.');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const pendingAction = new Map();

const MAIN_KEYBOARD = {
  keyboard: [
    ['➕ Добавить', '📋 Список'],
    ['❌ Удалить', '🕒 Время'],
    ['ℹ️ Помощь'],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

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
    timeZone: BOT_TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function withKeyboard() {
  return { reply_markup: MAIN_KEYBOARD };
}

function sendMainMenu(chatId, text) {
  return bot.sendMessage(chatId, text, withKeyboard());
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
  '/add ДД.MM.ГГГГ ЧЧ:ММ текст — задача на указанную дату и время\n' +
  '/add ЧЧ:ММ текст — задача на сегодня/завтра в указанное время\n' +
  '/add текст — задача через 1 час\n' +
  '/add ... /m15 — напомнить за 15 минут до события (по умолчанию /m0)\n' +
  '/list — показать список ближайших задач\n' +
  '/delete N — удалить задачу под номером N из списка /list\n\n' +
  '/time — показать текущее время бота (чтобы сверить часовой пояс)\n\n' +
  'Также можно пользоваться кнопками внизу чата.\n\n' +
  'Примеры:\n' +
  '/add 25.03.2026 10:00 созвон с клиентом\n' +
  '/add 19.30 отправить отчёт\n' +
  '/add 09:15 проверить почту\n' +
  '/add 20:35 тест уведомления /m15';

async function createTaskFromInput(chatId, rawText) {
  const text = (rawText || '').trim();
  if (!text) {
    await sendMainMenu(
      chatId,
      'Использование:\n' +
        '/add ДД.MM.ГГГГ ЧЧ:ММ текст\n\n' +
        'Также можно:\n' +
        '/add ЧЧ:ММ текст\n' +
        '/add текст\n' +
        '/add ... /m15 (напомнить за 15 минут)\n\n' +
        'Пример:\n' +
        '/add 25.03.2026 10:00 созвон с клиентом'
    );
    return;
  }
  const allTasks = await loadTasks();
  const now = new Date();
  let remindBeforeMinutes = DEFAULT_REMIND_BEFORE_MINUTES;
  let preparedText = text;

  // Опциональный суффикс: /m15 или /r15
  const remindMatch = preparedText.match(/(?:^|\s)\/[mr](\d{1,4})\s*$/i);
  if (remindMatch) {
    remindBeforeMinutes = Math.max(0, Number(remindMatch[1]));
    preparedText = preparedText.replace(/(?:^|\s)\/[mr]\d{1,4}\s*$/i, '').trim();
    if (!preparedText) {
      throw new Error('После /mN должен быть текст задачи. Пример: /add 20:35 созвон /m15');
    }
  }
  const { eventTime, title } = parseAddInput(preparedText, now);

  const task = {
    id: generateId(),
    title,
    dateTime: eventTime.toISOString(),
    remindBeforeMinutes,
    repeat: 'once',
    telegramTo: String(chatId),
    createdAt: now.toISOString(),
  };

  allTasks.push(task);
  await saveTasks(allTasks);

  await sendMainMenu(
    chatId,
    'Задача создана ✅\n' +
      `Когда: ${formatDateTime(task.dateTime)}\n` +
      `Напомню за ${task.remindBeforeMinutes} минут до события.\n` +
      'Проверить список: /list'
  );
}

async function sendTaskList(chatId) {
  const allTasks = await loadTasks();
  const myTasks = filterTasksForChat(allTasks, chatId);
  if (!myTasks.length) {
    await sendMainMenu(chatId, 'У тебя пока нет задач.');
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
  await sendMainMenu(
    chatId,
    'Твои задачи:\n\n' +
      lines.join('\n') +
      '\n\nЧтобы удалить: /delete N (номер из списка).'
  );

  // Inline-кнопки: удаление в 1 клик по конкретной задаче
  const inlineKeyboard = sorted.slice(0, 10).map((t, idx) => ([
    { text: `🗑 Удалить #${idx + 1}`, callback_data: `delid:${t.id}` },
  ]));
  await bot.sendMessage(chatId, 'Быстрое удаление:', {
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

async function deleteTaskByNumber(chatId, n) {
  if (!Number.isFinite(n) || n <= 0) {
    await sendMainMenu(chatId, 'Номер задачи должен быть положительным числом.');
    return;
  }
  const allTasks = await loadTasks();
  const myTasks = filterTasksForChat(allTasks, chatId);
  if (!myTasks.length) {
    await sendMainMenu(chatId, 'У тебя нет задач для удаления.');
    return;
  }
  const sorted = [...myTasks].sort(
    (a, b) => new Date(a.dateTime) - new Date(b.dateTime)
  );
  if (n > sorted.length) {
    await sendMainMenu(chatId, `Нет задачи под номером ${n}. Введи /list, чтобы посмотреть номера.`);
    return;
  }
  const target = sorted[n - 1];
  const remaining = allTasks.filter((t) => t.id !== target.id);
  await saveTasks(remaining);
  await sendMainMenu(
    chatId,
    `Удалил задачу №${n}:\n${formatDateTime(target.dateTime)} — ${target.title}`
  );
}

async function deleteTaskById(chatId, taskId) {
  const allTasks = await loadTasks();
  const myTasks = filterTasksForChat(allTasks, chatId);
  if (!myTasks.length) {
    await sendMainMenu(chatId, 'У тебя нет задач для удаления.');
    return;
  }
  const target = myTasks.find((t) => t.id === taskId);
  if (!target) {
    await sendMainMenu(chatId, 'Эта задача уже удалена или недоступна.');
    return;
  }
  const remaining = allTasks.filter((t) => t.id !== taskId);
  await saveTasks(remaining);
  await sendMainMenu(
    chatId,
    `Удалил задачу:\n${formatDateTime(target.dateTime)} — ${target.title}`
  );
}

bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  log('start from', chatId);
  await sendMainMenu(chatId, HELP_TEXT);
});

bot.onText(/^\/help$/, async (msg) => {
  const chatId = msg.chat.id;
  await sendMainMenu(chatId, HELP_TEXT);
});

bot.onText(/^\/menu$/, async (msg) => {
  const chatId = msg.chat.id;
  await sendMainMenu(chatId, HELP_TEXT);
});

bot.onText(/^\/time$/, async (msg) => {
  const chatId = msg.chat.id;
  const now = new Date();
  await sendMainMenu(
    chatId,
    `🕒 Время бота: ${now.toLocaleString('ru-RU', { timeZone: BOT_TZ })}\nTZ: ${BOT_TZ}`
  );
});

function isSameDateParts(d, year, month, day, hour, minute) {
  return (
    d.getFullYear() === year &&
    d.getMonth() === month &&
    d.getDate() === day &&
    d.getHours() === hour &&
    d.getMinutes() === minute
  );
}

function parseAddInput(input, now) {
  // 1) DD.MM.YYYY HH:MM text  или  DD.MM.YYYY HH.MM text
  let m = input.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2})[:.](\d{2})\s+(.+)$/);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]) - 1;
    const year = Number(m[3]);
    const hour = Number(m[4]);
    const minute = Number(m[5]);
    const title = m[6].trim();
    const dt = new Date(year, month, day, hour, minute);
    if (
      Number.isNaN(dt.getTime()) ||
      !isSameDateParts(dt, year, month, day, hour, minute)
    ) {
      throw new Error('Неверная дата/время. Пример: /add 25.03.2026 10:00 созвон');
    }
    if (dt <= now) {
      throw new Error('Дата/время уже в прошлом. Укажи время в будущем.');
    }
    return { eventTime: dt, title };
  }

  // 2) HH:MM text  или HH.MM text  — на сегодня/завтра
  m = input.match(/^(\d{1,2})[:.](\d{2})\s+(.+)$/);
  if (m) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    const title = m[3].trim();
    if (hour > 23 || minute > 59) {
      throw new Error('Неверное время. Пример: /add 19:30 созвон');
    }
    const dt = new Date(now);
    dt.setSeconds(0, 0);
    dt.setHours(hour, minute, 0, 0);
    if (dt <= now) {
      dt.setDate(dt.getDate() + 1);
    }
    return { eventTime: dt, title };
  }

  // 3) /add текст — через 1 час
  return {
    eventTime: new Date(now.getTime() + 60 * 60 * 1000),
    title: input.trim(),
  };
}

// /add (гибкий формат)
bot.onText(/^\/add(?:\s+(.+))?$/s, async (msg, match) => {
  const chatId = msg.chat.id;
  const text = (match[1] || '').trim();
  try {
    await createTaskFromInput(chatId, text);
  } catch (err) {
    log('add error', err);
    await sendMainMenu(
      chatId,
      'Не получилось сохранить задачу.\n' +
      String(err.message || err) +
      '\n\nФормат:\n/add ДД.MM.ГГГГ ЧЧ:ММ текст'
    );
  }
});

// /list
bot.onText(/^\/list$/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    await sendTaskList(chatId);
  } catch (err) {
    log('list error', err);
    await sendMainMenu(
      chatId,
      'Не получилось получить список задач. Попробуйте позже.'
    );
  }
});

// /delete N
bot.onText(/^\/delete\s+(\d+)$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const n = parseInt(match[1], 10);
  try {
    await deleteTaskByNumber(chatId, n);
  } catch (err) {
    log('delete error', err);
    await sendMainMenu(
      chatId,
      'Не получилось удалить задачу. Попробуйте позже.'
    );
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!text) return;
  if (text.startsWith('/')) return;

  try {
    const pending = pendingAction.get(chatId);
    if (pending === 'add') {
      pendingAction.delete(chatId);
      await createTaskFromInput(chatId, text);
      return;
    }
    if (pending === 'delete') {
      pendingAction.delete(chatId);
      const n = Number(text.replace(/[^\d]/g, ''));
      await deleteTaskByNumber(chatId, n);
      return;
    }

    if (text === '➕ Добавить') {
      pendingAction.set(chatId, 'add');
      await sendMainMenu(
        chatId,
        'Отправь задачу одним сообщением.\n\n' +
          'Примеры:\n' +
          '25.03.2026 10:00 созвон /m15\n' +
          '19:30 отправить отчёт /m5\n' +
          'проверить почту'
      );
      return;
    }
    if (text === '📋 Список') {
      await sendTaskList(chatId);
      return;
    }
    if (text === '❌ Удалить') {
      pendingAction.set(chatId, 'delete');
      await sendMainMenu(chatId, 'Напиши номер задачи для удаления (посмотри номера через /list).');
      return;
    }
    if (text === '🕒 Время') {
      const now = new Date();
      await sendMainMenu(
        chatId,
        `🕒 Время бота: ${now.toLocaleString('ru-RU', { timeZone: BOT_TZ })}\nTZ: ${BOT_TZ}`
      );
      return;
    }
    if (text === 'ℹ️ Помощь') {
      await sendMainMenu(chatId, HELP_TEXT);
      return;
    }
  } catch (err) {
    log('message handler error', err);
    await sendMainMenu(chatId, 'Не получилось обработать сообщение. Попробуй ещё раз.');
  }
});

bot.on('callback_query', async (q) => {
  const chatId = q.message?.chat?.id;
  const data = q.data || '';
  if (!chatId) return;
  try {
    if (data.startsWith('delid:')) {
      const taskId = data.slice('delid:'.length);
      await deleteTaskById(chatId, taskId);
      await bot.answerCallbackQuery(q.id, { text: 'Задача удалена' });
      return;
    }
    await bot.answerCallbackQuery(q.id);
  } catch (err) {
    log('callback error', err);
    await bot.answerCallbackQuery(q.id, { text: 'Ошибка удаления', show_alert: false }).catch(() => {});
  }
});

log('Telegram‑бот запущен. Ожидаю команды…');

