import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionOrNull } from "@/lib/server/session";
import { can } from "@/lib/server/authz";
import { saveFile, MAX_UPLOAD_BYTES } from "@/lib/media/store";
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

  const file = form.get("file");
  const channel = String(form.get("channel") ?? "") as SendChannel;
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Файл не выбран" }, { status: 400 });
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
    stored = await saveFile(Buffer.from(await file.arrayBuffer()));
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
