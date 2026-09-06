import { prisma } from "@/lib/db";
import { visitTitle } from "@/lib/visit-title";

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
        services: { select: { service: { select: { title: true } } } },
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
        services: { select: { service: { select: { title: true } } } },
      },
    }),
  ]);

  if (upcoming.length === 0 && past.length === 0) return "";

  /**
   * Имя визита — это его состав (§8, lib/visit-title).
   *
   * Мать записывает себя и ребёнка одной записью. Назвать ей только первую
   * услугу — сказать неправду о её же визите: она придёт вдвоём, а услышала
   * про один приём.
   */
  const line = (a: {
    startAt: Date;
    staff: { name: string } | null;
    primaryService: { title: string } | null;
    services: { service: { title: string } }[];
  }) =>
    `• ${when.format(a.startAt)} — ` +
    visitTitle(
      a.services.map((s) => ({ title: s.service.title })),
      a.primaryService?.title ?? "приём",
    ) +
    `${a.staff?.name ? `, ${a.staff.name}` : ""}`;

  const lines: string[] = [];
  if (upcoming.length > 0) {
    lines.push("ЗАПИСИ ЭТОГО ПАЦИЕНТА (о них можно рассказать, если спросит):");
    for (const a of upcoming) lines.push(line(a));
  }
  if (past.length > 0) {
    lines.push("Был у нас:");
    for (const a of past) lines.push(line(a));
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

/**
 * Ближайшая запись пациента человеческой строкой.
 *
 * Нужна, когда пациент сам говорит о своей записи: «Записана на 8 сентября».
 * Отвечать на это оформлением с нуля — «на какую услугу вы хотите записаться»
 * — значит показать, что записи мы не видим, хотя она у нас перед глазами.
 *
 * Имя визита берём общей функцией (`visitTitle`): у записи бывает несколько
 * услуг — мать записывает себя и ребёнка одной, — и назвать пациенту только
 * первую значит сказать ему неправду о его же визите (§8).
 */
export async function upcomingBookingLine(
  companyId: string,
  patientId: string | null,
  now: Date = new Date(),
): Promise<string | null> {
  if (!patientId) return null;
  const next = await prisma.appointment.findFirst({
    where: {
      companyId,
      patientId,
      deletedAt: null,
      status: { notIn: ["CANCELLED", "NO_SHOW"] },
      startAt: { gte: now },
    },
    orderBy: { startAt: "asc" },
    select: {
      startAt: true,
      staff: { select: { name: true } },
      primaryService: { select: { title: true } },
      services: { select: { service: { select: { title: true } } } },
    },
  });
  if (!next) return null;
  const title = visitTitle(
    next.services.map((s) => ({ title: s.service.title })),
    next.primaryService?.title ?? "приём",
  );
  return `${when.format(next.startAt)} — ${title}${next.staff?.name ? `, ${next.staff.name}` : ""}`;
}
