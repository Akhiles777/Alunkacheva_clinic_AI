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

/**
 * Причина отказа возвращается вместе с результатом, а не через переменную
 * модуля.
 *
 * Сначала она лежала в модульной переменной — и это была ошибка: бот отвечает
 * нескольким пациентам одновременно, отправки разных чатов идут параллельно, и
 * причина одного отказа приписалась бы другому. В диагностике это хуже
 * молчания: она указала бы не туда.
 */
export interface SendResult {
  ok: boolean;
  externalId?: string;
  /** Почему не ушло. Пусто — всё прошло. */
  error?: string;
}

/**
 * Сколько раз пробуем достучаться до Telegram.
 *
 * Сеть до api.telegram.org с российского сервера работает с перебоями: одно
 * сообщение уходит, следующее нет. Одна повторная попытка через полсекунды
 * закрывает большую часть таких обрывов и стоит ничего. Больше повторов не
 * делаем: вебхук обязан ответить Telegram быстро, иначе он пришлёт update
 * заново и пациент получит два ответа.
 */
const ATTEMPTS = 2;
const RETRY_DELAY_MS = 500;

interface CallResult<T> {
  value: T | null;
  error?: string;
}

async function call<T>(method: string, body: unknown): Promise<CallResult<T>> {
  const t = token();
  if (!t) return { value: null, error: "TELEGRAM_BOT_TOKEN не задан" };

  let error: string | undefined;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${API}/bot${t}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        // Вебхук должен ответить Telegram быстро, иначе он повторит доставку.
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      if (!res.ok) {
        /**
         * Описание ошибки Telegram кладёт в тело: «chat not found», «bot was
         * blocked by the user», «Too Many Requests: retry after 30». Каждая
         * означает своё, и без текста они неразличимы.
         */
        error = `Telegram ${res.status}: ${text.slice(0, 200)}`;
        // Отказ по сути (403, 400) повтором не лечится — только сетевой сбой.
        if (res.status < 500 && res.status !== 429) return { value: null, error };
      } else {
        const json = JSON.parse(text) as { ok: boolean; result?: T; description?: string };
        if (json.ok) return { value: json.result ?? null };
        return { value: null, error: `Telegram отказал: ${json.description ?? "без объяснения"}` };
      }
    } catch (e) {
      /**
       * Сюда попадают обрыв связи и таймаут — то, ради чего и нужен повтор.
       * Имя ошибки говорит, что именно: TimeoutError, TypeError (fetch failed).
       */
      error = `Связь с Telegram: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
    }

    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
  return { value: null, error };
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
  const path = file.value?.file_path;
  if (!path) return null;
  return `${API}/file/bot${t}/${path}`;
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
): Promise<SendResult> {
  const res = await call<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: keyboard(buttons),
    disable_web_page_preview: true,
  });
  return res.value
    ? { ok: true, externalId: String(res.value.message_id) }
    : { ok: false, error: res.error };
}

/** Запросить номер телефона кнопкой: надёжнее, чем разбирать текст. */
export async function requestPhone(chatId: string | number, text: string): Promise<SendResult> {
  const res = await call<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      keyboard: [[{ text: "📱 Отправить мой номер", request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
  // Исход отправки возвращаем вместе с причиной: по ним ставится отметка
  // доставки на сообщении, а причина объясняет отказ.
  return res.value
    ? { ok: true, externalId: String(res.value.message_id) }
    : { ok: false, error: res.error };
}

export async function removeKeyboard(chatId: string | number, text: string): Promise<SendResult> {
  const res = await call<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: { remove_keyboard: true },
  });
  return res.value
    ? { ok: true, externalId: String(res.value.message_id) }
    : { ok: false, error: res.error };
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
  return res.value === true;
}
