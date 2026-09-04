import { prisma } from "@/lib/db";
import { getCallbackQueue } from "@/lib/server/callback-queue";
import { getCourseEconomics } from "@/lib/server/course-economics";
import { getAgentStats } from "@/lib/server/agent-stats";
import { startOfClinicDay } from "@/lib/clinic-time";
import { revenueByDay } from "@/lib/server/daily-revenue";
import { getDashboardMetricsDb } from "@/lib/server/analytics";

/**
 * Снимок клиники для ИИ-аналитика — из базы.
 *
 * Прежде выжимка собиралась в браузере, по стору. А стор наполняется тем, что
 * нужно экрану: расписанием на сегодня и списком пациентов без визитов.
 * Поэтому аналитик владельца отвечал только про сегодняшний день и не знал ни
 * истории визитов, ни выручки, ни услуг — не потому, что плохо думал, а
 * потому что этих данных ему не давали.
 *
 * Здесь — агрегаты по всей базе. Персональные данные не уходят: ни ФИО, ни
 * телефонов, ни диагнозов (§7). Только числа и названия услуг.
 *
 * Периоды считаются той же функцией, что и раздел «Отчёты». Это не экономия
 * кода, а требование: аналитик и отчёты обязаны показывать одно и то же. Стоит
 * посчитать здесь по-своему — и владелец получит две разные правды, а поверит
 * той, что удобнее.
 */

const DAY = 24 * 3600 * 1000;

function money(v: number): string {
  return `${Math.round(v).toLocaleString("ru-RU")} ₽`;
}

export async function buildClinicSnapshot(companyId: string, now = new Date()): Promise<string> {
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthAgo = new Date(now.getTime() - 30 * DAY);
  const quarterAgo = new Date(now.getTime() - 90 * DAY);
  const yearAgo = new Date(now.getTime() - 365 * DAY);
  // Сутки клиники, а не сервера: иначе «новых пациентов сегодня» ночью врёт.
  const startOfToday = startOfClinicDay(now);

  const [
    patients,
    withVisits,
    newToday,
    appts,
    arrived,
    arrivedMonth,
    arrivedQuarter,
    plannedAhead,
    revenueYear,
    revenueMonth,
    firstVisits,
    dialogs,
    openEscalations,
    topServices,
    topStaff,
    coursesYearAgg,
    coursesMonthAgg,
    sources,
    gaps,
  ] = await Promise.all([
    prisma.patient.count({ where: { companyId, deletedAt: null } }),
    // «С визитами» — у кого визит СОСТОЯЛСЯ: отменённая запись побывавшим в
    // клинике не делает. Тот же счёт, что в списке пациентов.
    prisma.patient.count({
      where: { companyId, deletedAt: null, appointments: { some: { deletedAt: null, status: "ARRIVED" } } },
    }),
    prisma.patient.count({
      where: { companyId, deletedAt: null, firstSeenExact: true, firstSeenAt: { gte: startOfToday } },
    }),
    prisma.appointment.count({ where: { companyId, deletedAt: null } }),
    prisma.appointment.count({ where: { companyId, deletedAt: null, status: "ARRIVED" } }),
    prisma.appointment.count({
      where: { companyId, deletedAt: null, status: "ARRIVED", startAt: { gte: monthAgo } },
    }),
    prisma.appointment.count({
      where: { companyId, deletedAt: null, status: "ARRIVED", startAt: { gte: quarterAgo } },
    }),
    prisma.appointment.count({
      where: { companyId, deletedAt: null, status: { notIn: ["CANCELLED"] }, startAt: { gte: now } },
    }),
    prisma.appointment.aggregate({
      where: { companyId, deletedAt: null, status: "ARRIVED", startAt: { gte: yearAgo } },
      _sum: { revenue: true },
    }),
    prisma.appointment.aggregate({
      where: { companyId, deletedAt: null, status: "ARRIVED", startAt: { gte: startOfMonth } },
      _sum: { revenue: true },
    }),
    prisma.appointment.count({ where: { companyId, deletedAt: null, isFirstVisit: true } }),
    prisma.conversation.count({ where: { companyId } }),
    prisma.escalation.count({ where: { companyId, status: { not: "RESOLVED" } } }),
    /**
     * Услуги — по составу визита, а не по основной услуге.
     *
     * У записи основная услуга одна, а услуг в ней бывает несколько. Услуга,
     * которая всегда идёт второй, по основной не находится вовсе: «Инфузия
     * Ферро-Баланс» — четыре визита в отчёте по услугам и ноль у аналитика.
     * Две правды об одном — ровно то, чем этот проект уже обжигался (§8).
     *
     * В составе визита у каждой услуги своя стоимость, и сумма по составу
     * сходится с выручкой визита.
     */
    prisma.appointmentService.groupBy({
      by: ["serviceId"],
      where: {
        companyId,
        appointment: {
          deletedAt: null,
          status: "ARRIVED",
          startAt: { gte: quarterAgo },
        },
      },
      _count: { _all: true },
      _sum: { priceCharged: true },
    }),
    prisma.appointment.groupBy({
      by: ["staffId"],
      where: { companyId, deletedAt: null, status: "ARRIVED", startAt: { gte: quarterAgo } },
      _count: { _all: true },
      _sum: { revenue: true },
    }),
    // Продажи в кассе: оплата курса записью уже в выручке визита.
    prisma.coursePurchase.aggregate({
      where: { companyId, isCourse: true, purchasedAt: { gte: yearAgo } },
      _sum: { amount: true },
    }),
    prisma.coursePurchase.aggregate({
      where: { companyId, isCourse: true, purchasedAt: { gte: startOfMonth } },
      _sum: { amount: true },
    }),
    prisma.patient.groupBy({
      by: ["sourceId"],
      where: { companyId, deletedAt: null },
      _count: { _all: true },
    }),
    prisma.$queryRaw<{ avg: number | null }[]>`
      SELECT AVG(EXTRACT(EPOCH FROM diff) / 86400)::float AS avg
        FROM (
          SELECT "startAt" - LAG("startAt") OVER (PARTITION BY "patientId" ORDER BY "startAt") AS diff
            FROM appointments
           WHERE "companyId" = ${companyId} AND "deletedAt" IS NULL AND status = 'ARRIVED'
        ) g
       WHERE diff IS NOT NULL
    `,
  ]);

  const [serviceTitles, staffNames, sourceTitles] = await Promise.all([
    prisma.service.findMany({ where: { companyId }, select: { id: true, title: true } }),
    prisma.staff.findMany({ where: { companyId }, select: { id: true, name: true, specialty: true } }),
    prisma.source.findMany({ where: { companyId }, select: { id: true, title: true } }),
  ]);
  const serviceById = new Map(serviceTitles.map((s) => [s.id, s.title]));
  const staffById = new Map(staffNames.map((s) => [s.id, s]));
  const sourceById = new Map(sourceTitles.map((s) => [s.id, s.title]));

  const lines: string[] = [];
  lines.push("# База клиники (все данные, не только сегодня)");
  lines.push(
    `Пациентов всего: ${patients}; с визитами: ${withVisits}; обратились сегодня: ${newToday}.`,
  );
  const avg = gaps[0]?.avg;
  if (typeof avg === "number" && Number.isFinite(avg)) {
    lines.push(`Средний интервал между визитами: ${Math.round(avg)} дней.`);
  }

  /**
   * Выручка по дням — тот же срез, что у аналитика владельца.
   *
   * Ассистент на вопрос «какая выручка вчера» отвечал, что дневного среза нет.
   * Данные лежали в базе, просто в сводку не попадали.
   */
  /**
   * Месяц дней, а не две недели.
   *
   * На «посчитай за август с 1 по 25» аналитик отвечал месячными итогами: в
   * справке лежали только четырнадцать последних дней, и сложить нужный
   * отрезок было не из чего. Разрезы по услугам и людям остаются у последних
   * семи дней — иначе справка распухает без пользы.
   */
  const daily = await revenueByDay(companyId, 31, now);
  const todayKey = daily[daily.length - 1]?.date;
  const yesterdayKey = daily[daily.length - 2]?.date;
  lines.push("");
  lines.push("# Выручка по дням (последние 14 дней)");
  /**
   * Сеансы курса называем прямо. Иначе день «восемь приёмов, 12 000 ₽»
   * выглядит как провал или как потерянные данные, и объяснять это владельцу
   * приходится вручную.
   */
  lines.push(
    "Первичный — первый в истории пациента визит со статусом «пришёл»; повторный — " +
      "любой следующий. Первичные плюс повторные равны числу пришедших. Это не то же " +
      "самое, что «новые пациенты»: новым считается первое появление телефона в базе, " +
      "даже если человек ещё не дошёл до приёма. Отмена и неявка тоже разные вещи: об " +
      "отмене предупредили и время можно было продать заново, неявка — молча не пришёл.",
  );
  lines.push(
    "Выручка дня — деньги, принятые в этот день: стоимость приёмов плюс проданные " +
      "в этот день курсы. Курс оплачивается целиком при продаже, поэтому его сеансы " +
      "в другие дни выручки не дают: они помечены отдельно. Средний чек — деньги дня " +
      "делённые на оплаченные чеки: приёмы с суммой плюс проданные курсы. Сеансы " +
      "курса и бесплатные приёмы в знаменатель не идут.",
  );
  for (const d of daily) {
    const mark = d.date === todayKey ? " — СЕГОДНЯ" : d.date === yesterdayKey ? " — ВЧЕРА" : "";
    const course = d.courseSessions > 0 ? `, из них по курсу ${d.courseSessions}` : "";
    const sold =
      d.coursesSold > 0 ? `, продано курсов ${d.coursesSold} на ${d.coursesRevenue} ₽` : "";
    /**
     * Первичные и повторные — в каждой дневной строке.
     *
     * На вопрос «сколько сегодня первичных клиентов» аналитик отвечать не мог:
     * этого числа в справке не было вовсе, и он честно говорил общими словами.
     * Определение то же, что в отчётах (§8): первичный — первый в истории
     * пациента визит со статусом «пришёл».
     */
    const kinds =
      d.arrived > 0 ? `, первичных ${d.firstVisits}, повторных ${d.repeatVisits}` : "";
    // Отмены и неявки — разные вещи, и обе спрашивают. Новых пациентов тоже.
    const misses =
      (d.noShow > 0 ? `, неявок ${d.noShow}` : "") +
      (d.cancelled > 0 ? `, отмен ${d.cancelled}` : "") +
      (d.newPatients > 0 ? `, новых пациентов ${d.newPatients}` : "");
    lines.push(
      `- ${d.date} (${d.label})${mark}: ${d.revenue} ₽, пришли ${d.arrived}${kinds}${misses}${course}${sold}`,
    );
    /**
     * Разрезы дня с первичными внутри.
     *
     * «Первичные на остеопатию за сегодня» — обычный вопрос, и без первичных
     * внутри среза ответить на него нечем: аналитик видел только число приёмов
     * по услуге.
     */
    if (d.byService.length > 0) {
      lines.push(
        `    по услугам: ${d.byService
          .map((x) => `${x.name} — ${x.arrived} приёмов (первичных ${x.first}), ${x.revenue} ₽`)
          .join("; ")}`,
      );
    }
    if (d.byStaff.length > 0) {
      lines.push(
        `    по специалистам: ${d.byStaff
          .map((x) => `${x.name} — ${x.arrived} приёмов (первичных ${x.first}), ${x.revenue} ₽`)
          .join("; ")}`,
      );
    }
  }

  const coursesYear = Number(coursesYearAgg._sum.amount ?? 0);
  const coursesMonth = Number(coursesMonthAgg._sum.amount ?? 0);

  lines.push("");
  lines.push("# Визиты");
  lines.push(
    `Всего в базе: ${appts}; состоялись: ${arrived}; из них первичных: ${firstVisits}. ` +
      `За 30 дней состоялось: ${arrivedMonth}; за 90 дней: ${arrivedQuarter}. ` +
      `Запланировано вперёд: ${plannedAhead}.`,
  );
  /**
   * Выручка = приёмы плюс проданные курсы (§8).
   *
   * Здесь считались только приёмы, и аналитик называл владельцу число меньше
   * того, что стоит в отчётах: деньги за курсы приходят кассой, а не приёмом.
   */
  lines.push(
    `Выручка за 12 месяцев: ${money(Number(revenueYear._sum.revenue ?? 0) + coursesYear)}; ` +
      `с начала текущего месяца: ${money(Number(revenueMonth._sum.revenue ?? 0) + coursesMonth)}. ` +
      `Из них курсами: за год ${money(coursesYear)}, за месяц ${money(coursesMonth)}.`,
  );

  lines.push("");
  lines.push("# Услуги за 90 дней (по числу состоявшихся визитов)");
  for (const row of topServices
    .sort((a, b) => b._count._all - a._count._all)
    .slice(0, 15)) {
    const title = serviceById.get(row.serviceId) ?? "без услуги";
    lines.push(
      `- ${title}: ${row._count._all} визитов, ${money(Number(row._sum.priceCharged ?? 0))}`,
    );
  }

  lines.push("");
  lines.push("# Специалисты за 90 дней");
  for (const row of topStaff.sort((a, b) => b._count._all - a._count._all).slice(0, 15)) {
    const s = staffById.get(row.staffId);
    lines.push(
      `- ${s?.name ?? "—"}${s?.specialty ? ` (${s.specialty})` : ""}: ` +
        `${row._count._all} визитов, ${money(Number(row._sum.revenue ?? 0))}`,
    );
  }

  lines.push("");
  lines.push("# Источники пациентов");
  for (const row of sources.sort((a, b) => b._count._all - a._count._all)) {
    const title = row.sourceId ? (sourceById.get(row.sourceId) ?? "—") : "из выгрузки YCLIENTS";
    lines.push(`- ${title}: ${row._count._all}`);
  }

  lines.push("");
  lines.push(`# Переписка\nДиалогов: ${dialogs}; открытых эскалаций: ${openEscalations}.`);

  /**
   * Экономика курсов — теми же функциями, что вкладка отчётов и кабинет
   * владельца. Обязательства называем обязательствами: сложенные с выручкой,
   * они дают деньги, которых не было.
   */
  const courses = await getCourseEconomics(companyId, "month").catch(() => null);
  if (courses?.hasCourses) {
    const c = courses.completion;
    const o = courses.outstanding;
    const r = courses.repurchase;
    lines.push("");
    lines.push("# Экономика курсов");
    lines.push(
      c.rate === null
        ? `Доходимость за ${courses.periodLabel}: решившихся курсов нет — судить рано (идут ${c.inProgress}).`
        : `Доходимость за ${courses.periodLabel}: дошли ${c.completed} из ${c.completed + c.abandoned} ` +
          `решившихся (${Math.round(c.rate * 100)}%), ещё идут ${c.inProgress}. Сеансов пройдено ` +
          `${c.sessionsUsed} из ${c.sessionsPaid} оплаченных.`,
    );
    lines.push(
      `Оплачено вперёд и не отработано: ${money(o.obligation)} — ${o.sessions} сеансов в ` +
        `${o.courses} курсах; из них у выпавших из графика ${money(o.atRisk)}. ` +
        `ЭТО НЕ ВЫРУЧКА: деньги за курсы получены в дни продаж и посчитаны тогда же. ` +
        `Складывать эту сумму с выручкой периода нельзя.`,
    );
    lines.push(
      r.rate === null
        ? `Повторные покупки: судить не по кому — закончивших давно нет (ждём ${r.tooEarly}).`
        : `Повторные покупки за ${r.windowDays} дней после конца курса: ${r.repurchased} из ` +
          `${r.cohort} (${Math.round(r.rate * 100)}%), ждём ещё ${r.tooEarly}` +
          (r.medianDaysToRepurchase === null
            ? "."
            : `; возвращаются через ${r.medianDaysToRepurchase} дн. (медиана).`),
    );
    if (courses.rhythm.length) {
      lines.push(
        "Ритм сеансов: " +
          courses.rhythm
            .map((x) => `${x.serviceTitle} — раз в ${x.medianDays ?? "?"} дн. (медиана)`)
            .join("; "),
      );
    }
  }

  /**
   * Очередь «Кому позвонить» — теми же расчётами, что и экран.
   *
   * Без неё аналитик отвечал про выпавших из курса своей арифметикой по
   * карточкам пациентов, и число расходилось с экраном. Одна метрика — одна
   * функция (§8): владелец поверит удобной, а расхождение всплывёт в
   * разговоре с клиентом.
   */
  const queue = await getCallbackQueue(companyId).catch(() => null);
  if (queue) {
    const byKind = new Map<string, { n: number; money: number }>();
    for (const r of queue.rows) {
      const acc = byKind.get(r.kind) ?? { n: 0, money: 0 };
      acc.n += 1;
      acc.money += r.money ?? 0;
      byKind.set(r.kind, acc);
    }
    const label: Record<string, string> = {
      COURSE_STALLED: "выпали из курса",
      COURSE_FINISHING: "курс на финише",
      NO_SHOW: "не пришли",
      SLEEPING: "давно не были",
    };
    lines.push("");
    lines.push("# Кому позвонить (рабочая очередь)");
    lines.push(
      queue.rows.length === 0
        ? "Список пуст: у всех кандидатов есть будущая запись."
        : `Всего ${queue.rows.length}: ` +
          [...byKind]
            .map(([kind, v]) => `${label[kind] ?? kind} — ${v.n} на ${money(v.money)}`)
            .join("; "),
    );
    if (queue.withoutThreshold > 0) {
      lines.push(
        `Ещё ${queue.withoutThreshold} человек не в списке: у их услуги не задан порог ` +
          `«пора звать», а запасного порога клиники нет. Это незаполненная настройка, ` +
          `а не отсутствие кандидатов.`,
      );
    }
    lines.push(
      `Из списка за ${queue.outcome.days} дней написали ${queue.outcome.outreaches}, ` +
        `записались ${queue.outcome.booked}, дошли ${queue.outcome.arrived} на ` +
        `${money(queue.outcome.revenue)}. Деньги — только состоявшихся визитов.`,
    );
    lines.push(
      "Суммы в очереди разные по смыслу: у курсов это уже полученные деньги " +
        "(обязательство отработать), у остальных — цена по прайсу, то есть план, а не выручка.",
    );
  }

  /**
   * Разрезы по периодам — теми же расчётами, что и в «Отчётах».
   *
   * Без них аналитик отвечал «точной цифры обращений за месяц нет»: он видел
   * только итоги за всё время и число «обратились сегодня». Владелец при этом
   * читал в приветствии, что аналитик видит воронку и загрузку кабинетов —
   * обещание, которого никто не выполнял.
   */
  for (const period of ["week", "month", "quarter"] as const) {
    const m = await getDashboardMetricsDb(companyId, period).catch(() => null);
    if (!m) continue;

    lines.push("");
    lines.push(`# ${m.period.label} (${m.period.from.slice(0, 10)} — ${m.period.to.slice(0, 10)}, рабочих дней ${m.period.workingDays})`);
    lines.push(
      `Воронка: обращений ${m.funnel.inquiries}, записались ${m.funnel.booked}, пришли ${m.funnel.arrived}. ` +
        (m.fromDialog ? `Из переписки с агентом: записались ${m.fromDialog.booked}, пришли ${m.fromDialog.arrived}.` : ""),
    );
    lines.push(
      `Выручка ${money(m.money.revenue)}; средний чек ${money(m.money.avgCheck)}; ` +
        `новых пациентов ${m.money.newPatients}.`,
    );
    lines.push(`Записалось за период по дате записи: ${m.bookedInPeriod}.`);
    lines.push(
      `Состоявшиеся визиты: первичных ${m.visitMix.first}, курсовых ${m.visitMix.courseSession}, ` +
        `повторных ${m.visitMix.returned}, всего ${m.visitMix.total}.`,
    );

    const sources = m.sources.filter((s) => s.inquiries > 0 || s.booked > 0);
    if (sources.length) {
      lines.push(
        "Обращения по источникам: " +
          sources.map((s) => `${s.title} — ${s.inquiries} обращений, ${s.booked} записей`).join("; "),
      );
    }
    /**
     * Чем известен источник. Без этой строки аналитик выдавал бы разрез по
     * источникам за измеренный факт, хотя большая его часть выведена из
     * переписки, а часть записей источника не имеет вовсе.
     */
    if (m.sourceAttribution.total > 0) {
      lines.push(
        `Источник записей: вручную ${m.sourceAttribution.manual}, выведено из переписки ` +
          `${m.sourceAttribution.derived}, неизвестен ${m.sourceAttribution.unknown} из ` +
          `${m.sourceAttribution.total}. Неизвестный источник — звонок или приход без ` +
          `переписки; каналом его называть нельзя.`,
      );
    }

    const staff = m.staff.filter((s) => s.appointments > 0);
    if (staff.length) {
      lines.push(
        "Специалисты: " +
          staff.map((s) => `${s.name} — ${s.appointments} приёмов, ${money(s.revenue)}`).join("; "),
      );
      /**
       * Курсы без специалиста называем и здесь.
       *
       * Иначе аналитик складывает строки, получает меньше итога и объясняет
       * разницу как умеет — то есть выдумывает. На экране это число стоит
       * отдельной строкой, и в разговоре оно должно быть тем же.
       */
      if (m.money.coursesWithoutStaff > 0) {
        lines.push(
          `Ещё ${money(m.money.coursesWithoutStaff)} — курсы, у которых специалист не определился ` +
            "(сеансов по ним пока не было, а услугу ведёт не один человек). Эти деньги есть в " +
            "выручке и в разрезе по услугам, но ни у кого в строке специалиста.",
        );
      }
    }

    if (m.rooms.length) {
      lines.push(
        "Загрузка кабинетов за период: " +
          m.rooms.map((r) => `${r.roomName} — ${Math.round(r.periodOccupancy * 100)}%`).join("; "),
      );
    }
  }

  /**
   * Работа ассистента — теми же функциями, что и раздел в кабинете владельца.
   *
   * Без этих строк на «сколько диалогов агент закрыл сам» и «за сколько мы
   * отвечаем» аналитик отвечал общими словами: чисел ему просто не давали.
   * Считать здесь своё нельзя — это была бы вторая правда о работе агента.
   */
  const agent = await getAgentStats(companyId, "month");
  if (agent.hasData) {
    lines.push("");
    lines.push("# Работа ассистента за месяц");
    lines.push(
      "«Закрыл сам» — разговор, где сутки после ответа агента не вмешивался сотрудник, " +
        "не заводилась эскалация и пациент не переспросил в ближайшие два часа. Это не то же " +
        "самое, что «агент ответил»: ответивший невпопад успешным не считается.",
    );
    lines.push(
      agent.autonomy.rate === null
        ? "- Автономность: агент в периоде не отвечал."
        : `- Закрыл сам ${agent.autonomy.closedByAgent} из ${agent.autonomy.total} разговоров ` +
          `(${Math.round(agent.autonomy.rate * 100)}%); ушло человеку ${agent.autonomy.wentToHuman}.`,
    );
    lines.push(
      agent.reliability.attempts === 0
        ? "- Обращений к модели в периоде не было."
        : `- Попыток ответить ${agent.reliability.attempts}, успешных ` +
          `${agent.reliability.ok} (${Math.round((agent.reliability.okRate ?? 0) * 100)}%), ` +
          `таймаутов ${agent.reliability.timeout}, ошибок провайдера ${agent.reliability.providerError}; ` +
          `повтор спас ${agent.reliability.savedByRetry} ответов.`,
    );
    const speed = (label: string, st: { medianMs: number | null; count: number }) =>
      st.count === 0 ? `${label}: не было` : `${label}: медиана ${Math.round((st.medianMs ?? 0) / 1000)} с (${st.count})`;
    lines.push(
      `- Скорость первого ответа — ${speed("ассистент", agent.responseTime.agent)}; ` +
        `${speed("человек в рабочие часы", agent.responseTime.staffWorkingHours)}; ` +
        `${speed("человек вне часов", agent.responseTime.staffAfterHours)}. ` +
        `Без ответа осталось обращений: ${agent.responseTime.unanswered}.`,
    );
    if (agent.escalations.length > 0) {
      lines.push(
        "- Эскалации по поводам: " +
          agent.escalations.map((e) => `${e.reason} — ${e.count}`).join("; ") +
          `; не разобрано ${agent.escalationAck.unacknowledged}.`,
      );
    }
    lines.push(
      agent.savings.byTopic.length === 0
        ? "- Сэкономленное время посчитать не по чему: ни по одной теме не набралось пяти ручных " +
          "ответов для сравнения. Не придумывай это число."
        : `- Сэкономлено примерно ${(agent.savings.savedMs / 3600000).toFixed(1)} ч по ` +
          `${agent.savings.byTopic.length} темам. Встречное число обязательно называть рядом: ` +
          `на эскалации люди потратили ${(agent.savings.escalationCostMs / 3600000).toFixed(1)} ч ` +
          `(${agent.savings.escalations} разговоров).` +
          (agent.savings.skippedTopics.length > 0
            ? ` Ещё для ${agent.savings.skippedTopics.length} тем данных не хватило — их вклад не учтён.`
            : ""),
    );
  }

  /**
   * Помесячная динамика: без неё на вопрос «как изменилось» аналитик отвечал
   * общими словами. Считаем прямо в базе — двенадцать месяцев одним запросом.
   */
  const byMonth = await prisma.$queryRaw<{ month: Date; visits: bigint; revenue: number | null }[]>`
    SELECT date_trunc('month', "startAt") AS month,
           COUNT(*)                       AS visits,
           SUM(revenue)::float            AS revenue
      FROM appointments
     WHERE "companyId" = ${companyId}
       AND "deletedAt" IS NULL
       AND status = 'ARRIVED'
       AND "startAt" >= ${new Date(now.getFullYear() - 1, now.getMonth(), 1)}
     GROUP BY 1
     ORDER BY 1
  `;
  if (byMonth.length) {
    lines.push("");
    lines.push("# По месяцам (состоявшиеся визиты и выручка)");
    for (const row of byMonth) {
      lines.push(
        `- ${row.month.toISOString().slice(0, 7)}: ${Number(row.visits)} визитов, ${money(Number(row.revenue ?? 0))}`,
      );
    }
  }

  /**
   * Удержание. Владельца интересует не «сколько пришло», а «сколько
   * вернулось»: на этом строится вся экономика клиники, где курс лечения —
   * три-пять приёмов.
   */
  const [returning, once] = await Promise.all([
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count FROM (
        SELECT "patientId" FROM appointments
         WHERE "companyId" = ${companyId} AND "deletedAt" IS NULL AND status = 'ARRIVED'
         GROUP BY "patientId" HAVING COUNT(*) > 1
      ) t
    `,
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count FROM (
        SELECT "patientId" FROM appointments
         WHERE "companyId" = ${companyId} AND "deletedAt" IS NULL AND status = 'ARRIVED'
         GROUP BY "patientId" HAVING COUNT(*) = 1
      ) t
    `,
  ]);
  const repeat = Number(returning[0]?.count ?? 0);
  const single = Number(once[0]?.count ?? 0);
  if (repeat + single > 0) {
    lines.push("");
    lines.push(
      `# Удержание\nВернулись хотя бы раз: ${repeat} из ${repeat + single} пациентов с визитами ` +
        `(${Math.round((repeat / (repeat + single)) * 100)}%).`,
    );
  }

  /** Отмены и неявки: прямые потери, о которых спрашивают в первую очередь. */
  const [cancelled, noShow] = await Promise.all([
    prisma.appointment.count({ where: { companyId, deletedAt: null, status: "CANCELLED" } }),
    prisma.appointment.count({ where: { companyId, deletedAt: null, status: "NO_SHOW" } }),
  ]);
  lines.push("");
  lines.push(`# Потери\nОтменённых записей: ${cancelled}; неявок: ${noShow}.`);

  return lines.join("\n");
}
