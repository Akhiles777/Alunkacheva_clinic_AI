/**
 * Клиент Telegram Bot API. Единственное место, откуда уходят запросы в
 * Telegram: бизнес-логика про HTTP ничего не знает — как и для остальных
 * каналов (§5).
 */

const API = "https://api.telegram.org";

function token(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN || null;
}

export function isTelegramConfigured(): boolean {
  return Boolean(token());
}

export interface InlineButton {
  text: string;
  /** До 64 байт — ограничение Telegram. */
  data: string;
}

async function call<T>(method: string, body: unknown): Promise<T | null> {
  const t = token();
  if (!t) return null;
  try {
    const res = await fetch(`${API}/bot${t}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // Вебхук должен ответить Telegram быстро, иначе он повторит доставку.
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { ok: boolean; result?: T };
    return json.ok ? (json.result ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Ссылка на файл пациента.
 *
 * Живёт около часа и содержит токен бота, поэтому её нельзя ни сохранять в
 * базу, ни отдавать в браузер: по такой ссылке открывается доступ ко всей
 * переписке клиники. Вызывается только из /api/media, который скачивает файл
 * на сервере и отдаёт вошедшему сотруднику.
 */
export async function fileLink(fileId: string): Promise<string | null> {
  const t = token();
  if (!t) return null;
  const file = await call<{ file_path?: string }>("getFile", { file_id: fileId });
  if (!file?.file_path) return null;
  return `${API}/file/bot${t}/${file.file_path}`;
}

/** Разбивка кнопок по рядам: длинные подписи — по одной в ряд. */
function keyboard(buttons: InlineButton[] | undefined) {
  if (!buttons || buttons.length === 0) return undefined;
  const rows: { text: string; callback_data: string }[][] = [];
  for (const b of buttons) {
    const cell = { text: b.text, callback_data: b.data };
    const last = rows[rows.length - 1];
    if (b.text.length <= 16 && last && last.length === 1 && last[0].text.length <= 16) last.push(cell);
    else rows.push([cell]);
  }
  return { inline_keyboard: rows };
}

export async function sendText(
  chatId: string | number,
  text: string,
  buttons?: InlineButton[],
): Promise<{ externalId: string } | null> {
  const res = await call<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: keyboard(buttons),
    disable_web_page_preview: true,
  });
  return res ? { externalId: String(res.message_id) } : null;
}

/** Запросить номер телефона кнопкой: надёжнее, чем разбирать текст. */
export async function requestPhone(chatId: string | number, text: string): Promise<boolean> {
  const res = await call("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      keyboard: [[{ text: "📱 Отправить мой номер", request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
  // Исход отправки возвращаем: по нему ставится отметка доставки на сообщении.
  return Boolean(res);
}

export async function removeKeyboard(chatId: string | number, text: string): Promise<boolean> {
  // Исход отправки возвращаем: по нему ставится отметка доставки на сообщении.
  return Boolean(await call("sendMessage", { chat_id: chatId, text, reply_markup: { remove_keyboard: true } }));
}

/** Убрать «часики» на нажатой кнопке. */
export async function answerCallback(callbackId: string, text?: string): Promise<void> {
  await call("answerCallbackQuery", { callback_query_id: callbackId, text });
}

/** Регистрация вебхука — вызывается скриптом при настройке. */
export async function setWebhook(url: string, secret: string): Promise<boolean> {
  const res = await call<boolean>("setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
  return res === true;
}
