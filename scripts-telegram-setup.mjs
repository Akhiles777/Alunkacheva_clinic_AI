/**
 * Регистрация вебхука Telegram. Запускать один раз после деплоя:
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... APP_URL=https://... node scripts-telegram-setup.mjs
 */
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const appUrl = process.env.APP_URL;
if (!token || !secret || !appUrl) {
  console.error("Нужны TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET и APP_URL");
  process.exit(1);
}
const url = `${appUrl.replace(/\/+$/, "")}/api/webhooks/telegram`;
const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  }),
});
const json = await res.json();
console.log(json.ok ? `вебхук зарегистрирован: ${url}` : `ошибка: ${JSON.stringify(json)}`);
