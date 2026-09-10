import { prisma } from "@/lib/db";
import { notifyStaff } from "@/lib/server/notify";
import { makeWeeklyDigest, type WeeklyDigestResult } from "@/lib/server/weekly-digest";

/**
 * Сформировать сводку и позвать владельца её прочитать.
 *
 * Отдельным файлом от расчёта, чтобы уведомление нельзя было отправить,
 * «пока считаем»: сначала сводка есть в базе, потом о ней сообщают. Обратный
 * порядок означал бы push со ссылкой на пустой экран.
 */

export interface DigestDelivery extends WeeklyDigestResult {
  notified: number;
}

/**
 * Кому уходит сводка.
 *
 * Владельцу и управляющему: это разбор денег и загрузки, и право смотреть
 * выручку здесь то же самое, что на экране отчётов (§9). Администратору она не
 * уходит — не потому, что секрет, а потому что она не про его работу.
 */
async function recipients(companyId: string): Promise<string[]> {
  const rows = await prisma.staffUser.findMany({
    where: { companyId, isActive: true, role: { in: ["OWNER", "MANAGER"] } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export async function deliverWeeklyDigest(companyId: string): Promise<DigestDelivery> {
  const result = await makeWeeklyDigest(companyId);

  /**
   * Уведомляем только о НОВОЙ сводке. Повторный прогон в то же утро — обычное
   * дело (перезапуск сервера, ручной вызов), и второй push об одном и том же
   * читается как поломка, а вместе с ним перестают читать и следующие.
   */
  if (!result.created) return { ...result, notified: 0 };

  const ids = await recipients(companyId);
  if (ids.length === 0) return { ...result, notified: 0 };

  const body =
    result.observations === 0
      ? "Ничего заметного: показатели недели в пределах обычного."
      : `Наблюдений: ${result.observations}. Что изменилось и на что посмотреть.`;

  const { created } = await notifyStaff({
    companyId,
    recipientIds: ids,
    kind: "SYSTEM",
    title: "Сводка недели",
    body,
    url: "/owner",
  }).catch(() => ({ created: 0, pushed: 0 }));

  return { ...result, notified: created };
}
