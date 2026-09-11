"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { requireId } from "@/lib/server/require-id";
import { getSystemReport, type SystemReport } from "@/lib/server/system-report";

/**
 * Раздел учёта: кто, с какого устройства и что делал.
 *
 * Ссылок на него нет нигде — владелец набирает адрес сам. Но скрытый адрес это
 * НЕ защита: кто угодно может набрать его тоже, а здесь видно, кто из
 * сотрудников чем занимается. Поэтому доступ проверяется по-настоящему, и
 * чужому раздел отвечает так, будто его не существует.
 */
async function requireOwner(): Promise<{ companyId: string }> {
  const session = await getSession();
  if (session.role !== "OWNER") {
    throw new Error("Раздел недоступен");
  }
  return { companyId: session.companyId };
}

export async function systemReport(windowDays: number): Promise<SystemReport> {
  const { companyId } = await requireOwner();
  // Срок приходит с экрана: ограничиваем, чтобы «за всё время» не превращалось
  // в разбор сотен тысяч строк на каждое открытие страницы.
  const days = Math.min(180, Math.max(1, Math.round(windowDays) || 30));
  return getSystemReport(companyId, days);
}

/**
 * Пометить устройство своим — или снять отметку.
 *
 * Заказчик просил не учитывать его собственные аппараты. По строке браузера
 * модель не определяется (у всех Mac она одна и та же, у всех iPhone тоже),
 * поэтому исключаем не «MacBook Air M2» по названию, а конкретное устройство
 * по отпечатку — точно и без угадывания.
 *
 * Скрытое не пропадает молча: число скрытых действий стоит на экране рядом.
 */
export async function setDeviceExcluded(
  deviceId: string,
  excluded: boolean,
  windowDays: number,
): Promise<SystemReport> {
  requireId(deviceId, "устройство");
  const { companyId } = await requireOwner();
  await prisma.knownDevice.updateMany({
    where: { id: deviceId, companyId },
    data: { excluded, excludedAt: excluded ? new Date() : null },
  });
  return systemReport(windowDays);
}

/** Подписать устройство: «мой рабочий ноутбук». Помогает не путать одинаковые. */
export async function setDeviceNote(
  deviceId: string,
  note: string,
  windowDays: number,
): Promise<SystemReport> {
  requireId(deviceId, "устройство");
  const { companyId } = await requireOwner();
  await prisma.knownDevice.updateMany({
    where: { id: deviceId, companyId },
    data: { note: note.trim().slice(0, 60) || null },
  });
  return systemReport(windowDays);
}
