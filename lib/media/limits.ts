import type { AttachmentKind } from "@/lib/agent/attachments";

/**
 * Что можно отправить пациенту и до какого размера.
 *
 * Пределы стоят ЗДЕСЬ, на нашей стороне, и проверяются до отправки — потому
 * что иначе человек узнаёт о них от провайдера и в его выражениях: «ошибка
 * 413». Администратор в этот момент держит в руках снимок направления и хочет
 * знать одно — можно его отправить или нет. Отказ должен называть предел и
 * говорить, что делать.
 *
 * Числа — не наши: это ограничения WhatsApp и Telegram. Мы их не поднимаем и
 * не занижаем; если провайдер откажет по своей причине, причина уйдёт в
 * переписку словами (`Message.failureReason`).
 */

export type SendChannel = "WHATSAPP" | "TELEGRAM" | "INSTAGRAM";

const MB = 1024 * 1024;

/** Пределы WhatsApp по видам файлов. */
const WHATSAPP: Partial<Record<AttachmentKind, number>> = {
  photo: 5 * MB,
  video: 16 * MB,
  voice: 16 * MB,
  audio: 16 * MB,
  document: 32 * MB,
};

/** Telegram: фотографии сжимает и режет жёстче, остальное — до 50 МБ. */
const TELEGRAM: Partial<Record<AttachmentKind, number>> = {
  photo: 10 * MB,
  video: 32 * MB,
  voice: 32 * MB,
  audio: 32 * MB,
  document: 32 * MB,
};

export function limitFor(channel: SendChannel, kind: AttachmentKind): number | null {
  if (channel === "WHATSAPP") return WHATSAPP[kind] ?? null;
  if (channel === "TELEGRAM") return TELEGRAM[kind] ?? null;
  return null;
}

/**
 * Вид файла по типу и имени.
 *
 * Тип приходит от браузера и бывает пустым (так отдаёт файлы часть версий
 * Safari), поэтому расширение — второй заход, а не первый: тип надёжнее.
 * Не опознали — «документ»: он отправляется как есть и ничего не обещает.
 */
export function kindOfFile(mimeType: string | null | undefined, fileName?: string | null): AttachmentKind {
  const mime = (mimeType ?? "").toLowerCase();
  if (mime.startsWith("image/")) return mime.includes("gif") ? "video" : "photo";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime) return "document";

  const ext = (fileName ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (["jpg", "jpeg", "png", "webp", "heic", "heif"].includes(ext)) return "photo";
  if (["mp4", "mov", "m4v", "3gp", "gif"].includes(ext)) return "video";
  if (["ogg", "oga", "opus", "mp3", "m4a", "wav", "aac"].includes(ext)) return "audio";
  return "document";
}

export function humanSize(bytes: number): string {
  if (bytes >= MB) {
    const mb = bytes / MB;
    return `${(mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10).toString().replace(".", ",")} МБ`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

export interface FileCheck {
  ok: boolean;
  /** Что сказать человеку. Пусто — всё в порядке. */
  reason?: string;
  kind: AttachmentKind;
}

export function checkFile(input: {
  channel: SendChannel;
  mimeType?: string | null;
  fileName?: string | null;
  sizeBytes: number;
}): FileCheck {
  const kind = kindOfFile(input.mimeType, input.fileName);

  if (input.channel === "INSTAGRAM") {
    /**
     * В Instagram файл уходит только публичной ссылкой — а публиковать снимок
     * пациента нельзя (§7). Пока это так, честнее отказать словами, чем
     * показать кнопку, которая молча не работает.
     */
    return { ok: false, kind, reason: "В Instagram файлы пока не отправляются — напишите текстом." };
  }

  if (input.sizeBytes <= 0) {
    return { ok: false, kind, reason: "Файл пустой." };
  }

  const limit = limitFor(input.channel, kind);
  if (limit === null) {
    return { ok: false, kind, reason: "Такие файлы канал не принимает." };
  }
  if (input.sizeBytes > limit) {
    const where = input.channel === "WHATSAPP" ? "WhatsApp" : "Telegram";
    return {
      ok: false,
      kind,
      reason: `${where} не принимает файл больше ${humanSize(limit)} (у вас ${humanSize(
        input.sizeBytes,
      )}). Сожмите или отправьте ссылкой.`,
    };
  }
  return { ok: true, kind };
}

/**
 * Сколько сообщений выйдет из текста.
 *
 * Длинный текст провайдер режет сам, и пациент получает обрывок без
 * объяснения. Предупреждаем до отправки — это ровно то место, где человек
 * может решить иначе.
 */
export const TEXT_LIMIT = 4000;

export function willSplit(text: string): number {
  return Math.ceil(text.length / TEXT_LIMIT);
}
