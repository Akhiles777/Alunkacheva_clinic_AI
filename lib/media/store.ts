import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

export function mediaRoot(): string {
  return process.env.MEDIA_DIR ?? path.join(process.cwd(), ".data", "media");
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
  return path.join(mediaRoot(), id.slice(0, 2), id);
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
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return {
    id,
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function readStored(id: string): Promise<Buffer | null> {
  try {
    return await readFile(pathOf(id));
  } catch {
    return null;
  }
}

export async function storedSize(id: string): Promise<number | null> {
  try {
    return (await stat(pathOf(id))).size;
  } catch {
    return null;
  }
}
