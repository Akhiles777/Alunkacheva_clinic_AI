import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionOrNull } from "@/lib/server/session";
import { can } from "@/lib/server/authz";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { saveStream, readParts, mediaRoot, MAX_UPLOAD_BYTES } from "@/lib/media/store";
import { chunkPlan } from "@/lib/media/chunks";
import { checkFile, humanSize, type SendChannel } from "@/lib/media/limits";

/**
 * Загрузка файла, который администратор собирается отправить пациенту.
 *
 * Отдельным обработчиком, а не серверным действием: у действий Next предел
 * тела около мегабайта, и фотография с телефона в него не влезает — отказ
 * приходил бы «ошибкой сервера» без объяснения. Здесь тело читается потоком, а
 * предел наш и назван словами.
 *
 * Файл сначала попадает в хранилище и только потом, отдельным действием, — в
 * переписку. Так работает предпросмотр: человек видит, что отправит, и может
 * передумать, ничего не отправив пациенту.
 *
 * Проверка канала идёт ЗДЕСЬ, до записи на диск: у WhatsApp и Telegram разные
 * пределы, и узнавать о них от провайдера после отправки — значит узнавать
 * тогда, когда исправить уже нечего.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getSessionOrNull();
  if (!session) return NextResponse.json({ error: "Нужен вход" }, { status: 401 });
  if (!(await can(session, "MESSAGE_PATIENTS"))) {
    return NextResponse.json({ error: "Нет права писать пациентам" }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Файл не дошёл целиком — попробуйте ещё раз" }, { status: 400 });
  }

  const channel = String(form.get("channel") ?? "") as SendChannel;
  /**
   * Файл приходит ЧАСТЯМИ (`chunk`, `uploadId`, `index`, `total`).
   *
   * nginx по умолчанию принимает тело запроса до 1 МБ, а в нашем конфиге
   * предел не поднят: фото с телефона (2–5 МБ) получало 413 HTML-страницей, и
   * поле ввода писало «проверьте связь». Части по 512 КБ проходят при любом
   * пределе, а обрыв на одной из них повторяется без повтора всего файла.
   * Целый файл одним запросом по-прежнему принимается.
   */
  const chunked = form.get("chunk");
  let file: { name: string; type: string; size: number; bytes: () => Promise<ArrayBuffer> };
  let assembled: string[] | null = null;
  if (chunked instanceof File) {
    const plan = chunkPlan({
      uploadId: String(form.get("uploadId") ?? ""),
      index: Number(form.get("index")),
      total: Number(form.get("total")),
      size: Number(form.get("size")),
      chunkBytes: chunked.size,
    });
    if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: 400 });
    const dir = path.join(/*turbopackIgnore: true*/ mediaRoot(), "uploads", `${session.userId ?? "anon"}-${plan.uploadId}`);
    await mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
    await writeFile(/*turbopackIgnore: true*/ path.join(dir, String(plan.index).padStart(5, "0")), Buffer.from(await chunked.arrayBuffer()));
    const have = (await readdir(/*turbopackIgnore: true*/ dir)).filter((n) => /^\d{5}$/.test(n)).sort();
    if (have.length < plan.total) return NextResponse.json({ received: have.length, total: plan.total });
    assembled = have.map((n) => path.join(dir, n));
    file = {
      name: String(form.get("name") ?? "файл"),
      type: String(form.get("type") ?? ""),
      size: plan.size,
      bytes: async () => new ArrayBuffer(0),
    };
    void cleanupOld(path.join(/*turbopackIgnore: true*/ mediaRoot(), "uploads"));
  } else {
    const whole = form.get("file");
    if (!(whole instanceof File)) {
      return NextResponse.json({ error: "Файл не выбран" }, { status: 400 });
    }
    file = { name: whole.name, type: whole.type, size: whole.size, bytes: () => whole.arrayBuffer() };
  }
  if (channel !== "WHATSAPP" && channel !== "TELEGRAM" && channel !== "INSTAGRAM") {
    return NextResponse.json({ error: "Неизвестный канал" }, { status: 400 });
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `Файл больше ${humanSize(MAX_UPLOAD_BYTES)} — платформа такие не принимает.` },
      { status: 413 },
    );
  }

  const verdict = checkFile({
    channel,
    mimeType: file.type,
    fileName: file.name,
    sizeBytes: file.size,
  });
  if (!verdict.ok) return NextResponse.json({ error: verdict.reason }, { status: 400 });

  /**
   * Длительность голосового приходит от браузера: сам файл мы не разбираем.
   * Не пришла — не выдумываем, просто не показываем.
   */
  const durationRaw = Number(form.get("durationSec"));
  const durationSec = Number.isFinite(durationRaw) && durationRaw > 0 ? Math.round(durationRaw) : null;

  let stored;
  try {
    stored = assembled
      ? await saveStream(readParts(assembled))
      : await saveStream((async function* () {
          yield new Uint8Array(await file.bytes());
        })());
    if (assembled) await rm(/*turbopackIgnore: true*/ path.dirname(assembled[0]), { recursive: true, force: true });
  } catch (e) {
    console.error(`[вложение] не сохранилось: ${(e as Error).message}`);
    return NextResponse.json({ error: "Файл не сохранился на сервере" }, { status: 500 });
  }

  const row = await prisma.mediaFile.create({
    data: {
      companyId: session.companyId,
      storageId: stored.id,
      kind: verdict.kind,
      mimeType: file.type || "application/octet-stream",
      fileName: file.name || null,
      sizeBytes: stored.sizeBytes,
      durationSec,
      uploadedById: session.userId,
    },
    select: { id: true, kind: true, mimeType: true, fileName: true, sizeBytes: true, durationSec: true },
  });

  return NextResponse.json({
    ...row,
    // Тот же адрес, что у вложений пациента: проверка входа и клиники там же.
    href: `/api/media?provider=LOCAL&ref=${encodeURIComponent(row.id)}`,
  });
}

/** Брошенные загрузки старше часа — убрать: обрыв не должен копить мусор на диске. */
async function cleanupOld(root: string): Promise<void> {
  try {
    for (const name of await readdir(/*turbopackIgnore: true*/ root)) {
      const p = path.join(root, name);
      const st = await stat(/*turbopackIgnore: true*/ p);
      if (Date.now() - st.mtimeMs > 3600_000) await rm(/*turbopackIgnore: true*/ p, { recursive: true, force: true });
    }
  } catch {
    // не к спеху
  }
}
