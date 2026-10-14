/**
 * Загрузка файла частями — правила для сервера и экрана.
 *
 * Часть меньше предела nginx по умолчанию (1 МБ) с запасом на заголовки
 * формы: файл любого допустимого размера проходит, даже если на сервере
 * `client_max_body_size` не поднят.
 */
export const CHUNK_BYTES = 512 * 1024;
/** Больше этого платформа не принимает ни от кого: у мессенджеров пределы ниже. */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const MAX_CHUNKS = Math.ceil(MAX_UPLOAD_BYTES / CHUNK_BYTES);

export type ChunkPlan =
  | { ok: true; uploadId: string; index: number; total: number; size: number }
  | { ok: false; error: string };

export function chunkPlan(input: { uploadId: string; index: number; total: number; size: number; chunkBytes: number }): ChunkPlan {
  // Идентификатор придумывает экран; из него строится путь на диске — только безопасные знаки.
  if (!/^[a-z0-9-]{8,64}$/i.test(input.uploadId)) return { ok: false, error: "Неверный идентификатор загрузки" };
  if (!Number.isInteger(input.total) || input.total < 1 || input.total > MAX_CHUNKS) {
    return { ok: false, error: "Файл больше допустимого" };
  }
  if (!Number.isInteger(input.index) || input.index < 0 || input.index >= input.total) {
    return { ok: false, error: "Неверный номер части" };
  }
  if (!Number.isFinite(input.size) || input.size <= 0 || input.size > MAX_UPLOAD_BYTES) {
    return { ok: false, error: "Файл больше допустимого" };
  }
  if (input.chunkBytes <= 0 || input.chunkBytes > CHUNK_BYTES) return { ok: false, error: "Часть файла больше допустимого" };
  if (Math.ceil(input.size / CHUNK_BYTES) !== input.total) return { ok: false, error: "Число частей не сходится с размером" };
  return { ok: true, uploadId: input.uploadId, index: input.index, total: input.total, size: input.size };
}

/** Разрезать файл на части для отправки. */
export function sliceFile(size: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (let start = 0; start < size; start += CHUNK_BYTES) out.push({ start, end: Math.min(size, start + CHUNK_BYTES) });
  return out;
}

/**
 * Что сказать человеку, если сервер ответил не JSON.
 *
 * nginx на превышение предела отвечает HTML-страницей 413; поле ввода падало
 * на её разборе и писало «проверьте связь» — неправду.
 */
export function uploadErrorText(status: number): string {
  if (status === 413) return "Сервер не принял файл: на нём стоит предел размера запроса (nginx). Файл отправится частями — повторите.";
  if (status === 401) return "Сессия закончилась — войдите заново";
  if (status >= 500) return "Сервер не сохранил файл — попробуйте ещё раз";
  return `Файл не загрузился (код ${status})`;
}
