import { z } from "zod";
import { KIND_LABEL, type IncomingAttachment } from "@/lib/agent/attachments";

/**
 * Вложения из update Telegram.
 *
 * Схема сообщения раньше описывала только текст и контакт. Zod по умолчанию
 * отбрасывает незнакомые поля молча, поэтому голосовое приходило как объект
 * без текста — и дальше терялось без единой записи в журнале. Здесь описаны
 * все виды, которые пациент реально присылает в клинику: голосовое, фото
 * направления, видео, документ, геопозиция.
 */

const PhotoSize = z.object({
  file_id: z.string(),
  file_size: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

export const TelegramAttachmentFields = {
  voice: z
    .object({ file_id: z.string(), duration: z.number().optional(), mime_type: z.string().optional(), file_size: z.number().optional() })
    .optional(),
  audio: z
    .object({
      file_id: z.string(),
      duration: z.number().optional(),
      mime_type: z.string().optional(),
      file_size: z.number().optional(),
      file_name: z.string().optional(),
    })
    .optional(),
  video: z
    .object({ file_id: z.string(), duration: z.number().optional(), mime_type: z.string().optional(), file_size: z.number().optional() })
    .optional(),
  video_note: z.object({ file_id: z.string(), duration: z.number().optional(), file_size: z.number().optional() }).optional(),
  /** Telegram присылает несколько размеров одной фотографии. */
  photo: z.array(PhotoSize).optional(),
  document: z
    .object({
      file_id: z.string(),
      mime_type: z.string().optional(),
      file_size: z.number().optional(),
      file_name: z.string().optional(),
    })
    .optional(),
  sticker: z.object({ file_id: z.string(), emoji: z.string().optional() }).optional(),
  location: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
  caption: z.string().optional(),
} as const;

type WithAttachments = {
  [K in keyof typeof TelegramAttachmentFields]?: z.infer<(typeof TelegramAttachmentFields)[K]>;
};

/**
 * Вложения сообщения. Пустой список означает «обычный текст» — это не ошибка.
 */
export function attachmentsFrom(msg: WithAttachments | undefined): IncomingAttachment[] {
  if (!msg) return [];
  const out: IncomingAttachment[] = [];

  if (msg.voice) {
    out.push({
      kind: "voice",
      label: KIND_LABEL.voice,
      source: { provider: "TELEGRAM", fileId: msg.voice.file_id },
      mimeType: msg.voice.mime_type ?? "audio/ogg",
      durationSec: msg.voice.duration,
      sizeBytes: msg.voice.file_size,
    });
  }

  if (msg.audio) {
    out.push({
      kind: "audio",
      label: KIND_LABEL.audio,
      source: { provider: "TELEGRAM", fileId: msg.audio.file_id },
      mimeType: msg.audio.mime_type,
      fileName: msg.audio.file_name,
      durationSec: msg.audio.duration,
      sizeBytes: msg.audio.file_size,
    });
  }

  if (msg.video) {
    out.push({
      kind: "video",
      label: KIND_LABEL.video,
      source: { provider: "TELEGRAM", fileId: msg.video.file_id },
      mimeType: msg.video.mime_type ?? "video/mp4",
      durationSec: msg.video.duration,
      sizeBytes: msg.video.file_size,
    });
  }

  // Кружок — тоже видео, отдельного обращения к нему не нужно.
  if (msg.video_note) {
    out.push({
      kind: "video",
      label: KIND_LABEL.video,
      source: { provider: "TELEGRAM", fileId: msg.video_note.file_id },
      mimeType: "video/mp4",
      durationSec: msg.video_note.duration,
      sizeBytes: msg.video_note.file_size,
    });
  }

  /**
   * Из набора размеров берём последний — он самый крупный. Пациент фотографирует
   * направление или анализы, и на уменьшенной копии текст не прочитать.
   */
  if (msg.photo?.length) {
    const largest = msg.photo[msg.photo.length - 1];
    out.push({
      kind: "photo",
      label: KIND_LABEL.photo,
      source: { provider: "TELEGRAM", fileId: largest.file_id },
      mimeType: "image/jpeg",
      sizeBytes: largest.file_size,
    });
  }

  if (msg.document) {
    out.push({
      kind: "document",
      label: KIND_LABEL.document,
      source: { provider: "TELEGRAM", fileId: msg.document.file_id },
      mimeType: msg.document.mime_type,
      fileName: msg.document.file_name,
      sizeBytes: msg.document.file_size,
    });
  }

  if (msg.sticker) {
    out.push({
      kind: "sticker",
      label: msg.sticker.emoji ? `${KIND_LABEL.sticker} ${msg.sticker.emoji}` : KIND_LABEL.sticker,
      source: { provider: "TELEGRAM", fileId: msg.sticker.file_id },
    });
  }

  if (msg.location) {
    /**
     * Координаты кладём в подпись, а не в файл: администратору нужен адрес, а
     * не вложение. Ссылку на карту он откроет сам.
     */
    out.push({
      kind: "location",
      label: `${KIND_LABEL.location}: ${msg.location.latitude.toFixed(5)}, ${msg.location.longitude.toFixed(5)}`,
      source: { provider: "NONE" },
    });
  }

  return out;
}
