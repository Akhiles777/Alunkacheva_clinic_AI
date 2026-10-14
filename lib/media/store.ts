import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile, open } from "node:fs/promises";
import path from "node:path";

/**
 * Своё хранилище файлов, которые клиника отправляет пациентам.
 *
 * До сих пор файлы у платформы были только чужие: вложения пациента живут у
 * провайдера, мы их проксируем и у себя не держим. Отправка своих требует
 * места, куда их положить, и решение здесь не техническое, а по §7.
 *
 * Почему на диск, а не публичной ссылкой провайдеру. У Green API есть
 * `sendFileByUrl` — он проще всего, и он же означает, что снимок направления
 * или согласие пациента лежит по открытому адресу, куда провайдер (и любой,
 * кто адрес узнал) ходит без спроса. Это разглашение сведений об обращении за
 * помощью — врачебная тайна, ст. 13 323-ФЗ. Поэтому файл никуда не
 * публикуется: он лежит на нашем диске и уходит провайдеру загрузкой
 * (`sendFileByUpload`), а сотруднику отдаётся через `/api/media` с проверкой
 * входа и клиники.
 *
 * Почему не в базу. Видео на десять мегабайт в Postgres — это те же десять
 * мегабайт в каждом бэкапе и в каждой выгрузке. База у клиники маленькая и
 * должна такой остаться.
 *
 * Каталог задаётся `MEDIA_DIR`; по умолчанию `.data/media` внутри проекта —
 * выкладка (`deploy/pm2-deploy.sh`) трогает только `.next*`, так что файлы
 * переживают обновление.
 */

/** Больше этого не принимаем ни от кого: у провайдеров пределы ниже. */
import { MAX_UPLOAD_BYTES } from "@/lib/media/chunks";
export { MAX_UPLOAD_BYTES };

export function mediaRoot(): string {
  // `||`, а не `??`: в .env стоит MEDIA_DIR="" — пустая строка, и с `??` файлы
  // ложились в корень проекта, а не в своё хранилище.
  return process.env.MEDIA_DIR?.trim() || path.join(/*turbopackIgnore: true*/ process.cwd(), ".data", "media");
}

/**
 * Путь файла внутри хранилища.
 *
 * Идентификатор мы выдаём сами (uuid) и всё равно проверяем: он приходит из
 * базы, но в базу может попасть что угодно, а `path.join` с «../» вывел бы
 * чтение за пределы каталога. Раскладываем по двум первым знакам — тысячи
 * файлов в одном каталоге замедляют даже `ls`.
 */
export function pathOf(id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("недопустимый идентификатор файла");
  return path.join(/*turbopackIgnore: true*/ mediaRoot(), id.slice(0, 2), id);
}

export interface StoredFile {
  id: string;
  sizeBytes: number;
  sha256: string;
}

export async function saveFile(bytes: Buffer): Promise<StoredFile> {
  if (bytes.byteLength === 0) throw new Error("пустой файл");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error("файл больше допустимого");
  const id = randomUUID();
  const file = pathOf(id);
  await mkdir(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true });
  await writeFile(/*turbopackIgnore: true*/ file, bytes);
  return {
    id,
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function readStored(id: string): Promise<Buffer | null> {
  try {
    const at = await locate(id);
    if (!at) return null;
    return await readFile(/*turbopackIgnore: true*/ at.path);
  } catch {
    return null;
  }
}

export async function storedSize(id: string): Promise<number | null> {
  return (await locate(id))?.size ?? null;
}

/**
 * Где лежит файл. Сначала хранилище; потом — старое место: пока `MEDIA_DIR=""`
 * читалось как настоящий путь, файлы ложились в `<проект>/<две буквы>/<id>`, и
 * после правки они не должны пропасть.
 */
export async function locate(id: string): Promise<{ path: string; size: number } | null> {
  const legacy = path.join(/*turbopackIgnore: true*/ process.cwd(), id.slice(0, 2), id);
  for (const p of [pathOf(id), legacy]) {
    try {
      return { path: p, size: (await stat(/*turbopackIgnore: true*/ p)).size };
    } catch {
      // нет здесь — смотрим дальше
    }
  }
  return null;
}

/**
 * Записать файл потоком — без того, чтобы держать его целиком в памяти.
 *
 * На сервере 2 ГБ и рядом второй проект: видео пациента на 15 МБ, прочитанное
 * в буфер разом, — это 15 МБ на каждый одновременный запрос. Пишем кусками во
 * временный файл и переименовываем только после успеха: оборванная запись не
 * должна выглядеть как готовый файл. Больше предела — запись прекращается и
 * временный файл удаляется.
 */
export async function saveStream(
  chunks: AsyncIterable<Uint8Array>,
  limitBytes: number = MAX_UPLOAD_BYTES,
): Promise<StoredFile> {
  const id = randomUUID();
  const file = pathOf(id);
  const tmp = `${file}.part`;
  await mkdir(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true });
  const handle = await open(/*turbopackIgnore: true*/ tmp, "w");
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of chunks) {
      size += chunk.byteLength;
      if (size > limitBytes) throw new Error("файл больше допустимого");
      hash.update(chunk);
      await handle.write(chunk);
    }
    await handle.close();
    if (size === 0) throw new Error("пустой файл");
    await rename(/*turbopackIgnore: true*/ tmp, file);
    return { id, sizeBytes: size, sha256: hash.digest("hex") };
  } catch (e) {
    await handle.close().catch(() => {});
    await rm(/*turbopackIgnore: true*/ tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** Части загрузки по очереди — источник для `saveStream`. */
export async function* readParts(paths: string[]): AsyncIterable<Uint8Array> {
  for (const p of paths) yield await readFile(/*turbopackIgnore: true*/ p);
}
