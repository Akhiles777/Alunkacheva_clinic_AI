"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { requireId } from "@/lib/server/require-id";
import { getSystemReport, type SystemReport } from "@/lib/server/system-report";
import { deviceKey, parseDevice } from "@/lib/metrics/device";
import { readDeviceId } from "@/lib/server/device-id";

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
  return getSystemReport(companyId, days, await readDeviceId());
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
  userId: string,
  fingerprint: string,
  excluded: boolean,
  windowDays: number,
): Promise<SystemReport> {
  requireId(userId, "сотрудник");
  requireId(fingerprint, "устройство");
  const { companyId } = await requireOwner();

  /**
   * Устройство может быть известно ТОЛЬКО по журналу.
   *
   * Отметка о входе завелась вместе с этим разделом, а журнал действий велся и
   * раньше — поэтому у давно работающих аппаратов своей строки ещё нет, и
   * кнопка «моё» у них была неактивна. Именно свои устройства владелец и
   * хочет отметить первыми, так что заводим строку здесь же, по тому, что
   * знаем из журнала.
   */
  const existing = await prisma.knownDevice.findUnique({
    where: { companyId_userId_fingerprint: { companyId, userId, fingerprint } },
    select: { id: true },
  });

  if (existing) {
    await prisma.knownDevice.update({
      where: { id: existing.id },
      data: { excluded, excludedAt: excluded ? new Date() : null },
    });
    return systemReport(windowDays);
  }

  /**
   * Строку журнала ищем по тому же ключу, которым устройство показано: у
   * помеченного браузера это метка, у остальных — отпечаток строки браузера.
   * Прежний запасной ход «последняя строка этого человека» убран: при двух
   * устройствах он заводил отметку не на тот аппарат.
   */
  const candidates = await prisma.auditLog.findMany({
    where: {
      companyId,
      actorId: userId,
      userAgent: { not: null },
      ...(fingerprint.startsWith("b:") ? { deviceId: fingerprint.slice(2) } : {}),
    },
    distinct: ["userAgent", "deviceId"],
    orderBy: { createdAt: "desc" },
    select: { userAgent: true, deviceId: true, createdAt: true },
    take: 50,
  });
  const match = candidates.find(
    (c) => deviceKey(parseDevice(c.userAgent).fingerprint, c.deviceId) === fingerprint,
  );
  if (!match?.userAgent) return systemReport(windowDays);

  const d = parseDevice(match.userAgent);
  await prisma.knownDevice.create({
    data: {
      companyId,
      userId,
      fingerprint,
      userAgent: match.userAgent,
      label: d.label,
      platform: d.platform,
      browser: d.browser,
      kind: d.kind,
      // Входов с него мы не считали: отметка о входе появилась позже журнала.
      logins: 0,
      firstSeenAt: match.createdAt,
      lastLoginAt: match.createdAt,
      excluded,
      excludedAt: excluded ? new Date() : null,
    },
  });
  return systemReport(windowDays);
}

/** Подписать устройство: «мой рабочий ноутбук». Помогает не путать одинаковые. */
export async function setDeviceNote(
  userId: string,
  fingerprint: string,
  note: string,
  windowDays: number,
): Promise<SystemReport> {
  requireId(userId, "сотрудник");
  requireId(fingerprint, "устройство");
  const { companyId } = await requireOwner();
  await prisma.knownDevice.updateMany({
    where: { companyId, userId, fingerprint },
    data: { note: note.trim().slice(0, 60) || null },
  });
  return systemReport(windowDays);
}
