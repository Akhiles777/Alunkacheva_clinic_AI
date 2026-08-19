import { prisma } from "@/lib/db";

/**
 * Что агент знает о записях пациента.
 *
 * Раньше он не знал ничего: на «а во сколько я записана?» отвечал общими
 * словами и звал администратора — при том, что ответ лежит в базе. Пациент,
 * которого клиника ведёт годами, спрашивает про свой же визит и слышит
 * «уточню у администратора».
 *
 * В промпт уходит только то, что и так знает сам пациент: услуга, день, время
 * и специалист по его собственной записи. Ни диагнозов, ни медицинских данных
 * (§7): это расписание, а не карточка.
 *
 * Расписанием агент по-прежнему не распоряжается (§6): рассказать о записи он
 * может, перенести или отменить — нет.
 */

/** Насколько назад помним состоявшиеся визиты: «были у нас в июне» — это факт. */
const PAST_DAYS = 90;

/** Сколько записей показываем: длинный список в промпте только мешает. */
const LIMIT = 5;

const when = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  weekday: "short",
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * Строки о записях пациента для промпта. Пусто — карточка не привязана или
 * визитов нет; тогда агент работает как раньше.
 */
export async function patientVisitsContext(
  companyId: string,
  patientId: string | null,
  now: Date = new Date(),
): Promise<string> {
  if (!patientId) return "";

  const [upcoming, past] = await Promise.all([
    prisma.appointment.findMany({
      where: {
        companyId,
        patientId,
        deletedAt: null,
        status: { notIn: ["CANCELLED", "NO_SHOW"] },
        startAt: { gte: now },
      },
      orderBy: { startAt: "asc" },
      take: LIMIT,
      select: {
        startAt: true,
        status: true,
        staff: { select: { name: true } },
        primaryService: { select: { title: true } },
      },
    }),
    prisma.appointment.findMany({
      where: {
        companyId,
        patientId,
        deletedAt: null,
        status: "ARRIVED",
        startAt: { gte: new Date(now.getTime() - PAST_DAYS * 24 * 3600 * 1000), lt: now },
      },
      orderBy: { startAt: "desc" },
      take: LIMIT,
      select: {
        startAt: true,
        staff: { select: { name: true } },
        primaryService: { select: { title: true } },
      },
    }),
  ]);

  if (upcoming.length === 0 && past.length === 0) return "";

  const lines: string[] = [];
  if (upcoming.length > 0) {
    lines.push("ЗАПИСИ ЭТОГО ПАЦИЕНТА (о них можно рассказать, если спросит):");
    for (const a of upcoming) {
      lines.push(
        `• ${when.format(a.startAt)} — ${a.primaryService?.title ?? "приём"}` +
          `${a.staff?.name ? `, ${a.staff.name}` : ""}`,
      );
    }
  }
  if (past.length > 0) {
    lines.push("Был у нас:");
    for (const a of past) {
      lines.push(
        `• ${when.format(a.startAt)} — ${a.primaryService?.title ?? "приём"}` +
          `${a.staff?.name ? `, ${a.staff.name}` : ""}`,
      );
    }
  }
  /**
   * Прямое ограничение рядом с данными, а не в общем промпте: соблазн
   * «перенесу вам на завтра» возникает именно здесь, когда запись перед
   * глазами.
   */
  lines.push(
    "Перенести или отменить запись ты не можешь — это делает администратор. " +
      "Про запись только рассказываешь.",
  );
  return lines.join("\n");
}
