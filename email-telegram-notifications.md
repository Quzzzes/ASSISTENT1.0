# Проверка почты и уведомления в Telegram для подписчиков

Да, это **реализуемо** в OpenClaw: проверка почтовых ящиков (Gmail) и отправка уведомлений в Telegram **конкретным подписчикам**.

---

## Как это устроено

1. **Почта** — через Gmail Pub/Sub: при новом письме Gmail шлёт push в OpenClaw webhook.
2. **Webhook** — обрабатывает событие и по правилам (mappings) решает, куда отправить уведомление.
3. **Telegram** — канал OpenClaw с ботом; в маппинге указываем `channel: "telegram"` и `to: "<chat_id_подписчика>"`.

В итоге: пришло письмо → webhook → уведомление в Telegram нужному пользователю.

---

## Что нужно подготовить

| Компонент | Назначение |
|-----------|------------|
| **Gmail** | Ящик(и) для мониторинга (один общий или отдельный на подписчика) |
| **GCP + Gmail Pub/Sub** | Чтобы Gmail слал события в OpenClaw (см. [Gmail Pub/Sub](https://docs.openclaw.ai/gmail-pubsub)) |
| **OpenClaw Gateway** | С включёнными hooks и пресетом `gmail` |
| **Telegram-бот** | Токен в `channels.telegram.botToken` или `TELEGRAM_BOT_TOKEN` |
| **Список подписчиков** | Telegram Chat ID каждого, кому слать уведомления |

---

## Схема: один ящик → один подписчик

Один почтовый ящик — уведомления уходят одному пользователю в Telegram.

В `openclaw.json` (или в конфиге Gateway):

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    path: "/hooks",
    presets: ["gmail"],
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        wakeMode: "now",
        name: "Gmail → Telegram",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "📬 Новое письмо\nОт: {{messages[0].from}}\nТема: {{messages[0].subject}}\n\n{{messages[0].snippet}}",
        deliver: true,
        channel: "telegram",
        to: "123456789"
      },
    ],
  },
  channels: {
    telegram: {
      botToken: "YOUR_BOT_TOKEN",
      allowFrom: [123456789],
    },
  },
}
```

`to: "123456789"` — Telegram Chat ID подписчика (число в кавычках или без, в зависимости от парсера конфига).

---

## Схема: один ящик → несколько подписчиков

Нужно, чтобы одно и то же письмо порождало несколько уведомлений — по одному в Telegram каждому подписчику.

**Вариант A: несколько маппингов на один path**

Если один path может матчиться несколькими правилами и каждое делает свой `deliver` — заводим по маппингу на каждого подписчика с одним и тем же `match` и разным `to`:

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    path: "/hooks",
    presets: ["gmail"],
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        wakeMode: "now",
        name: "Gmail → Подписчик 1",
        sessionKey: "hook:gmail:{{messages[0].id}}:user1",
        messageTemplate: "📬 Новое письмо\nОт: {{messages[0].from}}\nТема: {{messages[0].subject}}\n\n{{messages[0].snippet}}",
        deliver: true,
        channel: "telegram",
        to: "111111111"
      },
      {
        match: { path: "gmail" },
        action: "agent",
        wakeMode: "now",
        name: "Gmail → Подписчик 2",
        sessionKey: "hook:gmail:{{messages[0].id}}:user2",
        messageTemplate: "📬 Новое письмо\nОт: {{messages[0].from}}\nТема: {{messages[0].subject}}\n\n{{messages[0].snippet}}",
        deliver: true,
        channel: "telegram",
        to: "222222222"
      },
    ],
  },
  channels: {
    telegram: {
      botToken: "YOUR_BOT_TOKEN",
      allowFrom: [111111111, 222222222],
    },
  },
}
```

`sessionKey` у каждого разный, чтобы не склеивать сессии.

**Вариант B: разные ящики под подписчиков**

- Отдельный Gmail-ящик (или label + отдельный watch) на каждого подписчика.
- Отдельный webhook path или отдельный маппинг под каждый ящик (если так поддерживается).
- В каждом маппинге свой `to` — один Telegram Chat ID.

Так проще логика «один абонент = один поток писем».

---

## Схема: разные ящики → разные подписчики

| Почтовый ящик   | Подписчик в Telegram (chat_id) |
|-----------------|----------------------------------|
| inbox1@gmail.com | 111111111 |
| inbox2@gmail.com | 222222222 |

Для каждого ящика:

1. Настроить Gmail watch и push на свой endpoint/path (например `/hooks/gmail-inbox1`, `/hooks/gmail-inbox2`).
2. В маппингах указать разный `match.path` и свой `to`:

```json5
mappings: [
  {
    match: { path: "gmail-inbox1" },
    action: "agent",
    wakeMode: "now",
    name: "Inbox1 → Telegram",
    sessionKey: "hook:gmail-inbox1:{{messages[0].id}}",
    messageTemplate: "📬 [Ящик 1] От: {{messages[0].from}}\nТема: {{messages[0].subject}}\n\n{{messages[0].snippet}}",
    deliver: true,
    channel: "telegram",
    to: "111111111"
  },
  {
    match: { path: "gmail-inbox2" },
    action: "agent",
    wakeMode: "now",
    name: "Inbox2 → Telegram",
    sessionKey: "hook:gmail-inbox2:{{messages[0].id}}",
    messageTemplate: "📬 [Ящик 2] От: {{messages[0].from}}\nТема: {{messages[0].subject}}\n\n{{messages[0].snippet}}",
    deliver: true,
    channel: "telegram",
    to: "222222222"
  },
]
```

---

## Как узнать Telegram Chat ID подписчика

1. **Через OpenClaw:** включить логи `openclaw logs --follow`, подписчик пишет боту в личку — в логе смотреть `from.id` (это chat_id).
2. **Через API:** `curl "https://api.telegram.org/bot<BOT_TOKEN>/getUpdates"` — после сообщения от пользователя в ответе будет `message.chat.id`.
3. Временно добавить пользователя в `allowFrom` (например по username), чтобы бот мог ему отвечать.

Добавьте всех подписчиков в `channels.telegram.allowFrom`, иначе доставка в Telegram может блокироваться.

---

## Минимальные шаги по настройке

1. Включить hooks и Gmail в OpenClaw (пресет `gmail`, при необходимости wizard: `openclaw webhooks gmail setup --account ...`).
2. Настроить Gmail Pub/Sub и push на URL OpenClaw (например через Tailscale Funnel или свой HTTPS endpoint).
3. Создать Telegram-бота, прописать `channels.telegram.botToken` и `allowFrom` со списком chat_id подписчиков.
4. Добавить один или несколько маппингов с `deliver: true`, `channel: "telegram"`, `to: "<chat_id>"` под нужные path (gmail или gmail-inbox1, gmail-inbox2 и т.д.).
5. Проверить: отправить тестовое письмо на мониторируемый ящик и убедиться, что в Telegram приходит уведомление нужному подписчику.

---

## Полезные ссылки

- [Gmail Pub/Sub → OpenClaw](https://docs.openclaw.ai/gmail-pubsub)
- [Webhooks](https://docs.openclaw.ai/automation/webhook)
- [Configuration Reference](https://docs.openclaw.ai/gateway/configuration-reference) — раздел hooks.mappings, deliver, channel, to
- [Telegram channel](https://open-claw.bot/docs/channels/telegram/) — allowFrom, botToken

При необходимости можно добавить кастомную логику (фильтр по отправителю, лейблам, теме) через transform в `~/.openclaw/hooks/transforms` и там же формировать список `to` для нескольких подписчиков, если один path должен рассылать одному списку.
