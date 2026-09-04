import { prisma } from "@/lib/db";
import { STALLED_DEFAULT_DAYS } from "@/app/_data/settings";

/**
 * Запасной порог «пора звать» — по компании, а не по сессии.
 *
 * Настройка живёт в блобе «clinic», и читать её через `getClinicSettings()`
 * нельзя везде: та функция берёт компанию из сессии. В фоновом расчёте сессии
 * нет, и она подставляет первую компанию из базы — а компаний в базе две.
 * Клиника получила бы чужой порог и чужой список «кому позвонить».
 *
 * Здесь компания передаётся явно, и перепутать её нельзя.
 */
export async function stalledFallbackDays(companyId: string): Promise<number | null> {
  const row = await prisma.setting.findUnique({
    where: { companyId_key: { companyId, key: "clinic" } },
    select: { value: true },
  });
  const blob = row?.value as { stalledDefaultDays?: number | null } | null;
  if (!blob || typeof blob !== "object") return STALLED_DEFAULT_DAYS;
  /**
   * Различаем «поля нет» и «поле очищено»: настройка появилась позже самой
   * записи, и `?? 14` вернуло бы четырнадцать дней клинике, которая нарочно
   * стёрла запасной порог.
   */
  return "stalledDefaultDays" in blob ? (blob.stalledDefaultDays ?? null) : STALLED_DEFAULT_DAYS;
}
