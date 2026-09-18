import { prisma } from "@/lib/db";
import { startOfClinicDay, clinicDateKey } from "@/lib/clinic-time";
import { clinicDayFor } from "@/lib/server/clinic-day";
import { freeGaps } from "@/lib/metrics/occupancy";
import { waitingSince } from "@/lib/inbox/waiting";
import { getCallbackQueue } from "@/lib/server/callback-queue";
import {
  attendanceBetween,
  getDashboardMetricsDb,
  periodBounds,
  roomOccupancyBetween,
} from "@/lib/server/analytics";
import { composeMessage } from "@/lib/assistant/admin-compose";
import { visitTitle } from "@/lib/visit-title";
import { answerAboutPatient, type AnswerFacts } from "@/lib/metrics/patient-answer";
import { explainUnmarked, UNMARKED_LABEL, type KnownMove, type OtherBooking } from "@/lib/metrics/unmarked";
import {
  ADMIN_ABILITIES,
  parseAdminQuestion,
  staffIn,
  type AdminAnswer,
  type AdminIntent,
  type BroadcastPlan,
  type BroadcastTarget,
  type DateRef,
} from "@/lib/assistant/admin-intents";

export type { AdminAnswer, BroadcastPlan, BroadcastTarget };

/**
 * Ассистент администратора: ответы по данным клиники и подготовка рассылок.
 *
 * Считает наш код, а не модель. Это не экономия: в ответах визиты, деньги и
 * имена пациентов — персональные и медицинские данные, наружу они не уходят
 * (§7), а число, сочинённое моделью, выглядит посчитанным и оказывается
 * неверным (§8). Здесь всё берётся из базы теми же правилами, что и на
 * экранах: разойтись с «Сегодня» и с карточкой ассистент не может.
 *
 * Ни одно сообщение отсюда не уходит само. Рассылка сначала показывается
 * целиком — текст, поимённый список и кому не уйдёт, — и ждёт подтверждения
 * человека; отправляет её уже отдельное действие (`app/(dashboard)/inbox`).
 */

const TIME = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});
const DAY_LABEL = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  timeZone: "Europe/Moscow",
});
const MONEY = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const rub = (n: number) => `${MONEY.format(Math.round(n))} ₽`;


function abilitiesText(lead: string): string {
  return `${lead}\n\nВот что я считаю и делаю:\n${ADMIN_ABILITIES.map((a) => `• ${a}`).join("\n")}`;
}

/** Сутки клиники, о которых спросили. */
function dayOf(date: DateRef, now: Date): { start: Date; end: Date } {
  const base =
    date.iso !== null
      ? new Date(`${date.iso}T12:00:00+03:00`)
      : new Date(now.getTime() + (date.offset ?? 0) * 24 * 3600 * 1000);
  const start = startOfClinicDay(base);
  return { start, end: new Date(start.getTime() + 24 * 3600 * 1000) };
}

interface DayAppt {
  id: string;
  patientId: string | null;
  patientName: string;
  staffId: string;
  staffName: string;
  startAt: Date;
  endAt: Date;
  durationMin: number;
  status: string;
  revenue: number;
  title: string;
  serviceIds: string[];
}

async function apptsOfDay(
  companyId: string,
  day: { start: Date; end: Date },
): Promise<DayAppt[]> {
  const rows = await prisma.appointment.findMany({
    where: {
      companyId,
      deletedAt: null,
      startAt: { gte: day.start, lt: day.end },
    },
    orderBy: { startAt: "asc" },
    select: {
      id: true,
      patientId: true,
      staffId: true,
      startAt: true,
      endAt: true,
      durationMin: true,
      status: true,
      revenue: true,
      primaryServiceId: true,
      primaryService: { select: { title: true } },
      patient: { select: { name: true } },
      staff: { select: { name: true } },
      services: { select: { serviceId: true, service: { select: { title: true } } } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    patientId: r.patientId,
    patientName: r.patient?.name?.trim() || "Без имени",
    staffId: r.staffId,
    staffName: r.staff?.name ?? "—",
    startAt: r.startAt,
    endAt: r.endAt,
    durationMin: r.durationMin,
    status: r.status,
    revenue: Number(r.revenue),
    // Имя визита — его состав, одной функцией на всю систему (§8).
    title: visitTitle(
      r.services.map((s) => ({ title: s.service.title })),
      r.primaryService?.title ?? "приём",
    ),
    serviceIds: [
      ...new Set([...(r.primaryServiceId ? [r.primaryServiceId] : []), ...r.services.map((s) => s.serviceId)]),
    ],
  }));
}

const active = (a: DayAppt) => a.status !== "CANCELLED";
const arrived = (a: DayAppt) => a.status === "ARRIVED";

function filtered(
  appts: DayAppt[],
  staffId: string | null,
  serviceId: string | null,
): DayAppt[] {
  return appts
    .filter(active)
    .filter((a) => (staffId ? a.staffId === staffId : true))
    .filter((a) => (serviceId ? a.serviceIds.includes(serviceId) : true));
}

/**
 * Имя врача в ответе — отдельной частью, а не в падеже.
 *
 * «у Ирина Алилгаджиевна» — так писать нельзя, а склонять имена кодом нельзя
 * тем более: однажды это сломается на чьей-нибудь фамилии (то же решение, что
 * у агента). Поэтому имя стоит впереди, через запятую: «Ирина Алилгаджиевна,
 * сегодня записано трое».
 */
function who(staffName: string | null): string {
  return staffName ? `${staffName}, ` : "";
}

/** «человек / человека / человек» — счёт людей по-русски. */
function people(n: number): string {
  return plural(n, "человек", "человека", "человек");
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

export interface AdminContext {
  companyId: string;
  /** Право видеть деньги: без него суммы не считаются и не называются (§9). */
  canSeeRevenue: boolean;
  /** Право писать пациентам: без него рассылка даже не готовится. */
  canMessage: boolean;
  /**
   * Право видеть ЧУЖИХ пациентов. Без него ассистент говорит только о приёмах
   * самого сотрудника: врач видит в платформе свой день, и обойти это через
   * чат было бы дырой в той же ролевой модели (§7).
   */
  canViewOthers?: boolean;
  /** Кто он в справочнике сотрудников — чтобы ограничить ответы его приёмами. */
  ownStaffId?: string | null;
  now?: Date;
}

/** Ответ для того, кому чужие пациенты не видны. */
const ONLY_OWN =
  "Этот вопрос про всю клинику, а у вашей учётки доступ только к своим приёмам. " +
  "Спросите про свой день: «сколько у меня сегодня», «кто следующий», «кто записан завтра».";

/**
 * Ответить на вопрос администратора.
 *
 * Возвращает текст, а для рассылки — ещё и план: что уйдёт и кому. Ничего не
 * отправляет и ничего не меняет в базе.
 */
export async function answerAdmin(question: string, ctx: AdminContext): Promise<AdminAnswer> {
  const now = ctx.now ?? new Date();
  const [staff, services] = await Promise.all([
    prisma.staff.findMany({
      where: { companyId: ctx.companyId, isActive: true, deletedAt: null },
      select: { id: true, name: true },
    }),
    prisma.service.findMany({
      where: { companyId: ctx.companyId, isActive: true },
      select: { id: true, title: true },
    }),
  ]);

  const intent = parseAdminQuestion(question, { staff, services }, now);
  const nameOf = (id: string | null) => staff.find((s) => s.id === id)?.name ?? null;

  /**
   * Врач видит только свои приёмы — то же правило, что в карточке пациента и
   * на экране врача. Ассистент не должен становиться обходным путём к чужим
   * данным: вопрос про клинику получает отказ словами, вопрос про свой день —
   * ответ, где врач подставлен сам.
   */
  const limited = ctx.canViewOthers === false;
  if (limited && !ctx.ownStaffId) {
    return {
      text:
        "Ассистент показывает данные клиники сотрудникам с доступом к карточкам пациентов. " +
        "У вашей учётки его нет — свои приёмы видно на экране «Мой день».",
    };
  }
  const mine = (id: string | null) => (limited ? (ctx.ownStaffId ?? null) : id);

  /**
   * Врача назвали, но их двое с таким именем — переспрашиваем.
   *
   * Это единственное место, где ассистент отвечает вопросом: назвать не того
   * врача значит посчитать чужой день, а в рассылке — написать чужим людям.
   */
  const ambiguous = staffIn(question, staff);
  if (ambiguous.one === null && ambiguous.many.length > 1 && intent.kind !== "patient") {
    return {
      text:
        `У нас несколько специалистов с таким именем: ${ambiguous.many.map((s) => s.name).join(", ")}. ` +
        "Уточните, о ком речь, — и я посчитаю.",
    };
  }

  switch (intent.kind) {
    case "help":
      return { text: abilitiesText("Я ассистент администратора: считаю по данным клиники и готовлю рассылки.") };

    case "day_load": {
      const staffId = mine(intent.staffId);
      return dayLoad(ctx, { ...intent, staffId }, nameOf(staffId), services, now);
    }

    case "day_money": {
      const staffId = mine(intent.staffId);
      return dayMoney(ctx, { ...intent, staffId }, nameOf(staffId), now);
    }

    case "remaining": {
      const staffId = mine(intent.staffId);
      return remaining(ctx, { ...intent, staffId }, nameOf(staffId), now);
    }

    case "now": {
      const staffId = mine(intent.staffId);
      return whoNow(ctx, staffId, nameOf(staffId), now);
    }

    case "free_slots": {
      const staffId = mine(intent.staffId);
      return freeSlots(ctx, { ...intent, staffId }, nameOf(staffId), now);
    }

    case "attendance":
      return limited ? { text: ONLY_OWN } : attendance(ctx, intent, now);

    case "rooms":
      return limited ? { text: ONLY_OWN } : roomsAnswer(ctx, intent.date, now);

    case "schedule": {
      const staffId = mine(intent.staffId);
      return scheduleList(ctx, { ...intent, staffId }, nameOf(staffId), now);
    }

    case "waiting":
      return limited ? { text: ONLY_OWN } : waitingAnswer(ctx, now);

    case "callbacks":
      return limited ? { text: ONLY_OWN } : callbacksAnswer(ctx);

    case "new_patients":
      return limited ? { text: ONLY_OWN } : newPatients(ctx, intent.date, now);

    case "message_one":
      return messageOne(ctx, intent, now);

    case "patients_total":
      return limited ? { text: ONLY_OWN } : patientsTotal(ctx);

    case "contacts":
      return limited ? { text: ONLY_OWN } : contacts(ctx, intent.name);

    case "period":
      return limited ? { text: ONLY_OWN } : periodAnswer(ctx, intent.period, intent.money);

    case "booking_refusal":
      return {
        text:
          "Записями я не распоряжаюсь: создать, перенести или отменить приём может только " +
          "администратор — в YCLIENTS или в панели записи. Это не ограничение доступа, а " +
          "граница зоны: расписание ведёт человек.\n\nЗато могу посчитать день, найти окна и " +
          "написать пациенту — скажите, что нужно.",
      };

    case "patient":
      return patientAnswer(ctx, intent.name, intent.question);


    case "broadcast":
      return broadcast(ctx, intent, nameOf(intent.staffId), now);

    default:
      return {
        text: abilitiesText(
          "Такого расчёта у меня нет — и выдумывать число я не буду.",
        ),
      };
  }
}

async function dayLoad(
  ctx: AdminContext,
  intent: Extract<AdminIntent, { kind: "day_load" }>,
  staffName: string | null,
  services: { id: string; title: string }[],
  now: Date,
): Promise<AdminAnswer> {
  const day = dayOf(intent.date, now);
  const appts = filtered(await apptsOfDay(ctx.companyId, day), intent.staffId, intent.serviceId);
  const serviceTitle = services.find((s) => s.id === intent.serviceId)?.title ?? null;
  const came = appts.filter(arrived).length;
  const ahead = appts.filter((a) => !arrived(a) && a.startAt > now).length;

  const what = serviceTitle ? ` на «${serviceTitle}»` : "";
  if (appts.length === 0) {
    return { text: cap(`${who(staffName)}${intent.date.label}${what} записей нет.`) };
  }

  const money =
    ctx.canSeeRevenue && appts.some((a) => a.revenue > 0)
      ? ` Принято по состоявшимся — ${rub(appts.filter(arrived).reduce((s, a) => s + a.revenue, 0))}.`
      : "";

  return {
    text:
      cap(
        `${who(staffName)}${intent.date.label}${what} записано ${appts.length} ` +
          `${people(appts.length)}: пришли ${came}, впереди ${ahead}.`,
      ) + money,
  };
}

async function dayMoney(
  ctx: AdminContext,
  intent: Extract<AdminIntent, { kind: "day_money" }>,
  staffName: string | null,
  now: Date,
): Promise<AdminAnswer> {
  if (!ctx.canSeeRevenue) {
    return { text: "Суммы показывает только сотрудник с доступом к выручке — у вашей учётки его нет." };
  }
  const day = dayOf(intent.date, now);
  const appts = filtered(await apptsOfDay(ctx.companyId, day), intent.staffId, null);
  const done = appts.filter(arrived);
  const takenMoney = done.reduce((s, a) => s + a.revenue, 0);
  const aheadList = appts.filter((a) => !arrived(a) && a.startAt > now);
  const aheadMoney = aheadList.reduce((s, a) => s + a.revenue, 0);

  /**
   * План и факт — разные числа, и складывать их нельзя (§8): деньги будущего
   * приёма это цена из записи, а не выручка. Поэтому две строки, а не одна.
   */
  return {
    text:
      cap(`${who(staffName)}${intent.date.label} принято ${rub(takenMoney)} по ${done.length} `) +
      `${plural(done.length, "состоявшемуся приёму", "состоявшимся приёмам", "состоявшимся приёмам")}. ` +
      (aheadList.length > 0
        ? `Впереди ещё ${aheadList.length} ${plural(aheadList.length, "запись", "записи", "записей")} на ${rub(aheadMoney)} по прайсу — это план, а не выручка.`
        : "Записей впереди на этот день нет."),
  };
}

async function remaining(
  ctx: AdminContext,
  intent: Extract<AdminIntent, { kind: "remaining" }>,
  staffName: string | null,
  now: Date,
): Promise<AdminAnswer> {
  const day = dayOf(intent.date, now);
  const appts = filtered(await apptsOfDay(ctx.companyId, day), intent.staffId, null).filter(
    (a) => !arrived(a) && a.startAt > now,
  );
  if (appts.length === 0) {
    return {
      text: cap(`${who(staffName)}${intent.date.label} принимать больше некого — записей впереди нет.`),
    };
  }
  const lines = appts
    .slice(0, 20)
    .map((a) => `• ${TIME.format(a.startAt)} — ${a.patientName}, ${a.title}${staffName ? "" : `, ${a.staffName}`}`);
  return {
    text:
      cap(`${who(staffName)}осталось принять ${appts.length} ${people(appts.length)}:\n`) +
      lines.join("\n") +
      (appts.length > 20 ? `\n…и ещё ${appts.length - 20}` : ""),
  };
}

async function whoNow(
  ctx: AdminContext,
  staffId: string | null,
  staffName: string | null,
  now: Date,
): Promise<AdminAnswer> {
  const day = dayOf({ offset: 0, iso: null, label: "сегодня" }, now);
  const appts = filtered(await apptsOfDay(ctx.companyId, day), staffId, null);
  const current = appts.find((a) => a.startAt <= now && a.endAt > now);
  const next = appts.find((a) => a.startAt > now);
  const parts: string[] = [];
  parts.push(
    current
      ? cap(
          `${who(staffName)}сейчас на приёме ${current.patientName} ` +
            `(${TIME.format(current.startAt)}–${TIME.format(current.endAt)}, ${current.title}` +
            `${staffName ? "" : `, ${current.staffName}`}).`,
        )
      : cap(`${who(staffName)}сейчас приёма нет.`),
  );
  parts.push(
    next
      ? `Следующий — ${next.patientName} в ${TIME.format(next.startAt)} (${next.title}${staffName ? "" : `, ${next.staffName}`}).`
      : "Дальше сегодня записей нет.",
  );
  return { text: parts.join(" ") };
}

async function freeSlots(
  ctx: AdminContext,
  intent: Extract<AdminIntent, { kind: "free_slots" }>,
  staffName: string | null,
  now: Date,
): Promise<AdminAnswer> {
  const day = dayOf(intent.date, now);
  const [{ window }, appts] = await Promise.all([
    clinicDayFor(ctx.companyId, day.start),
    apptsOfDay(ctx.companyId, day),
  ]);
  if (!window) return { text: `${cap(intent.date.label)} клиника не работает.` };

  const minute = (at: Date) => Math.round((at.getTime() - day.start.getTime()) / 60_000);
  const busy = filtered(appts, intent.staffId, null).map((a) => ({
    startMinute: minute(a.startAt),
    endMinute: minute(a.endAt),
  }));
  const gaps = freeGaps(busy, window, 30).filter(
    (g) => intent.date.offset !== 0 || g.endMinute > minute(now),
  );
  if (gaps.length === 0) {
    return { text: cap(`${who(staffName)}${intent.date.label} свободных окон от получаса нет.`) };
  }
  const at = (m: number) => TIME.format(new Date(day.start.getTime() + m * 60_000));
  return {
    text:
      cap(`${who(staffName)}свободно ${intent.date.label}:\n`) +
      gaps.map((g) => `• ${at(g.startMinute)}–${at(g.endMinute)} (${g.durationMin} мин)`).join("\n") +
      (intent.staffId
        ? "\nЭто окна по записям этого специалиста; кабинет мог быть занят другим приёмом."
        : "\nЭто окна по всем записям клиники разом."),
  };
}

async function attendance(
  ctx: AdminContext,
  intent: Extract<AdminIntent, { kind: "attendance" }>,
  now: Date,
): Promise<AdminAnswer> {
  const day = dayOf(intent.date, now);
  const appts = await apptsOfDay(ctx.companyId, day);
  const noShow = appts.filter((a) => a.status === "NO_SHOW");
  const planned = appts.filter((a) => a.status === "CREATED" || a.status === "CONFIRMED");

  /**
   * Неотмеченные разбираем тем же кодом, что и экран «Сегодня»: перенос это
   * или забытая отметка — там уже решено, и второй правды быть не должно (§8).
   */
  const moves = await prisma.appointmentMove.findMany({
    where: { companyId: ctx.companyId, fromStartAt: { gte: day.start, lt: day.end } },
    select: { fromStartAt: true, toStartAt: true, exact: true },
  });
  const knownMoves: KnownMove[] = moves.map((m) => ({
    fromStartAt: m.fromStartAt,
    toStartAt: m.toStartAt,
    exact: m.exact,
  }));

  const patientIds = [...new Set(planned.map((p) => p.patientId).filter(Boolean))] as string[];
  const others = patientIds.length
    ? await prisma.appointment.findMany({
        where: {
          companyId: ctx.companyId,
          deletedAt: null,
          patientId: { in: patientIds },
          status: { notIn: ["CANCELLED"] },
          createdAtYclients: { gte: day.start },
        },
        select: { id: true, patientId: true, startAt: true, createdAtYclients: true },
      })
    : [];

  const lines: string[] = [];
  lines.push(
    noShow.length === 0
      ? `${cap(intent.date.label)} неявок не отмечено.`
      : `Не пришли ${intent.date.label}: ${noShow.map((a) => `${a.patientName} (${TIME.format(a.startAt)})`).join(", ")}.`,
  );

  const unmarked = planned.filter((a) => a.endAt < now);
  if (unmarked.length > 0) {
    lines.push(`Без отметки ${unmarked.length} ${plural(unmarked.length, "приём", "приёма", "приёмов")}:`);
    for (const a of unmarked.slice(0, 15)) {
      const mine: OtherBooking[] = others
        .filter((o) => o.patientId === a.patientId && o.id !== a.id)
        .map((o) => ({
          appointmentId: o.id,
          startAt: o.startAt,
          createdAt: o.createdAtYclients ?? o.startAt,
        }));
      const verdict = explainUnmarked(
        { appointmentId: a.id, patientId: a.patientId, startAt: a.startAt, endedAt: a.endAt },
        knownMoves,
        mine,
        now,
      );
      lines.push(`• ${TIME.format(a.startAt)} — ${a.patientName}: ${UNMARKED_LABEL[verdict.kind]}`);
    }
  } else {
    lines.push("Прошедшие приёмы все отмечены.");
  }
  return { text: lines.join("\n") };
}

async function scheduleList(
  ctx: AdminContext,
  intent: Extract<AdminIntent, { kind: "schedule" }>,
  staffName: string | null,
  now: Date,
): Promise<AdminAnswer> {
  const day = dayOf(intent.date, now);
  const appts = filtered(await apptsOfDay(ctx.companyId, day), intent.staffId, intent.serviceId);
  if (appts.length === 0) {
    return { text: cap(`${who(staffName)}${intent.date.label} записей нет.`) };
  }
  const status: Record<string, string> = {
    ARRIVED: "пришёл",
    NO_SHOW: "не пришёл",
    CREATED: "ждём",
    CONFIRMED: "подтверждён",
  };
  return {
    text:
      cap(`${who(staffName)}записаны ${intent.date.label} — ${appts.length}:\n`) +
      appts
        .slice(0, 30)
        .map(
          (a) =>
            `• ${TIME.format(a.startAt)} — ${a.patientName}, ${a.title}` +
            `${staffName ? "" : `, ${a.staffName}`} · ${status[a.status] ?? a.status.toLowerCase()}`,
        )
        .join("\n") +
      (appts.length > 30 ? `\n…и ещё ${appts.length - 30}` : ""),
  };
}

/** «сегодня в 17:40», «завтра в 09:00» — момент отправки словами. */
function whenLabel(at: Date): string {
  const today = clinicDateKey(new Date());
  const key = clinicDateKey(at);
  const tomorrow = clinicDateKey(new Date(Date.now() + 24 * 3600 * 1000));
  const day = key === today ? "сегодня" : key === tomorrow ? "завтра" : DAY_LABEL.format(at);
  return `${day} в ${TIME.format(at)}`;
}

/**
 * Письмо одному пациенту — с подтверждением адресата.
 *
 * «Через пять часов напиши Патимат, которая была записана сегодня на
 * остеопатию, что врач задерживается»: имя в падеже, уточнение по записи и
 * отложенная отправка. Ошибиться адресатом здесь легче всего — двух Патимат в
 * базе достаточно, чтобы чужой человек получил чужую новость, — поэтому если
 * совпадений несколько, мы их перечисляем и ничего не отправляем.
 */
async function messageOne(
  ctx: AdminContext,
  intent: Extract<AdminIntent, { kind: "message_one" }>,
  now: Date,
): Promise<AdminAnswer> {
  if (!ctx.canMessage) {
    return { text: "Писать пациентам может сотрудник с таким правом — у вашей учётки его нет." };
  }

  let found = await findPatients(ctx.companyId, intent.name);
  if (found.length === 0) {
    return {
      text: `Пациента «${intent.name}» в базе не нашёл. Проверьте написание — или откройте переписку и напишите оттуда.`,
    };
  }

  /**
   * Тёзок отбираем по записи, о которой сказал администратор: «которая была
   * записана сегодня на остеопатию». Это не догадка — это его же слова.
   */
  const day = dayOf(intent.date, now);
  const appts = filtered(await apptsOfDay(ctx.companyId, day), intent.staffId, intent.serviceId);
  const booked = new Map(appts.filter((a) => a.patientId).map((a) => [a.patientId as string, a]));
  if (found.length > 1) {
    const narrowed = found.filter((p) => booked.has(p.id));
    if (narrowed.length === 1) found = narrowed;
  }
  if (found.length > 1) {
    return {
      text:
        `Таких пациентов несколько: ${found.map((p) => p.name ?? "без имени").join(", ")}. ` +
        "Назовите фамилию с именем или скажите, к какому врачу и на какой день он записан.",
    };
  }

  const patient = found[0];
  const appt = booked.get(patient.id) ?? null;

  /**
   * Текст: свой, если администратор его продиктовал, иначе — заготовка
   * клиники под названную ситуацию. Сочинять от себя нельзя: это письмо уйдёт
   * от имени клиники.
   */
  const text = intent.text
    ? intent.text
    : intent.situation
      ? composeMessage(intent.situation, {
          doctorName: appt?.staffName ?? null,
          visitTime: appt ? TIME.format(appt.startAt) : null,
          visitDay: appt ? intent.date.label : null,
          delayText: intent.delayText,
        })
      : "";
  if (!text) {
    return {
      text:
        `${patient.name ?? "Пациент"} — нашёл. Теперь скажите, что написать: ` +
        "или своими словами после двоеточия, или ситуацией — «врач задерживается», " +
        "«приём переносится», «врач заболел», «напомни о записи», «клиника не работает».",
    };
  }

  const phone = await prisma.patientPhone.findFirst({
    where: { companyId: ctx.companyId, patientId: patient.id },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    select: { phone: true },
  });
  const dialog = await prisma.conversation.findFirst({
    where: {
      companyId: ctx.companyId,
      patientId: patient.id,
      deletedAt: null,
      NOT: { externalUserId: { startsWith: "local-" } },
    },
    orderBy: { lastMessageAt: "desc" },
    select: { id: true, channel: true, isPractice: true },
  });

  const blocked = dialog?.isPractice
    ? "тренировочная переписка — наружу не уходит"
    : !dialog && !phone
      ? "нет номера в карточке"
      : dialog?.channel === "INSTAGRAM"
        ? "Instagram: первым пишет пациент"
        : null;

  /**
   * Отложенную отправку исполняет сервер по переписке (`DialogTask`), значит
   * без переписки её не поставить. Говорим об этом прямо, а не молчим: иначе
   * администратор будет ждать сообщения, которого никто не отправит.
   */
  const scheduled = intent.sendAtIso ? new Date(intent.sendAtIso) : null;
  const cannotSchedule = scheduled !== null && !dialog;

  const when = appt ? `${intent.date.label} в ${TIME.format(appt.startAt)}, ${appt.title}` : "записи в этот день нет";
  return {
    text:
      `${patient.name ?? "Пациент"} — ${when}. ` +
      (blocked
        ? `Отправить не получится: ${blocked}.`
        : cannotSchedule
          ? "Отложить не получится: переписки с этим человеком ещё нет, а завести её можно только отправкой. Могу отправить сразу — подтвердите."
          : scheduled
            ? `Отправлю ${whenLabel(scheduled)} — проверьте текст и адресата.`
            : "Проверьте текст и адресата — отправлю после подтверждения."),
    plan: {
      kind: "one",
      text,
      targets: [
        {
          patientId: patient.id,
          name: patient.name ?? "Пациент",
          when,
          blocked,
        },
      ],
      dayIso: clinicDateKey(day.start),
      staffId: intent.staffId,
      serviceId: intent.serviceId,
      staffName: appt?.staffName ?? null,
      dateLabel: DAY_LABEL.format(day.start),
      patientId: patient.id,
      sendAtIso: cannotSchedule ? null : (intent.sendAtIso ?? null),
      sendAtLabel: cannotSchedule || !scheduled ? null : whenLabel(scheduled),
    },
  };
}

/**
 * Занятость кабинетов за день — той же функцией, что и отчёты с кабинетом
 * владельца (`roomOccupancyBetween`). Своего расчёта здесь быть не должно:
 * два числа под одной подписью — та ошибка, на которой проект уже обжигался.
 */
async function roomsAnswer(ctx: AdminContext, date: DateRef, now: Date): Promise<AdminAnswer> {
  const day = dayOf(date, now);
  const rows = await roomOccupancyBetween(ctx.companyId, day.start, day.end);
  if (rows.length === 0) return { text: "Кабинеты в справочнике не заведены." };
  return {
    text:
      cap(`${date.label} по кабинетам:\n`) +
      rows
        .map(
          (r) =>
            `• ${r.name} — ${Math.round(r.rate * 100)}% (${Math.round(r.busyMinutes / 60)} ч из ${Math.round(r.availableMinutes / 60)})`,
        )
        .join("\n") +
      "\nВизиты без кабинета в счёт не идут — они видны в проверке состояния.",
  };
}

/** Сколько всего пациентов — тем же счётом, что и список «Пациенты». */
async function patientsTotal(ctx: AdminContext): Promise<AdminAnswer> {
  const [total, withVisits] = await Promise.all([
    prisma.patient.count({ where: { companyId: ctx.companyId, deletedAt: null } }),
    prisma.patient.count({
      where: {
        companyId: ctx.companyId,
        deletedAt: null,
        appointments: { some: { deletedAt: null, status: "ARRIVED" } },
      },
    }),
  ]);
  return {
    text: `В базе ${total} ${plural(total, "пациент", "пациента", "пациентов")}, из них ${withVisits} хотя бы раз были на приёме.`,
  };
}

/** Телефон и канал: то же, что видно в карточке. */
async function contacts(ctx: AdminContext, name: string): Promise<AdminAnswer> {
  const found = await findPatients(ctx.companyId, name);
  if (found.length === 0) return { text: `Пациента «${name}» в базе не нашёл.` };
  if (found.length > 1) {
    return { text: `Таких несколько: ${found.map((p) => p.name ?? "без имени").join(", ")}. Назовите точнее.` };
  }
  const [phones, dialog] = await Promise.all([
    prisma.patientPhone.findMany({
      where: { companyId: ctx.companyId, patientId: found[0].id },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      select: { phone: true, usedForWhatsapp: true },
    }),
    prisma.conversation.findFirst({
      where: { companyId: ctx.companyId, patientId: found[0].id, deletedAt: null },
      orderBy: { lastMessageAt: "desc" },
      select: { channel: true },
    }),
  ]);
  if (phones.length === 0) {
    return { text: `${found[0].name ?? "Пациент"}: номера в карточке нет.` };
  }
  return {
    text:
      `${found[0].name ?? "Пациент"}: ${phones.map((p) => p.phone + (p.usedForWhatsapp ? " (WhatsApp)" : "")).join(", ")}` +
      (dialog ? `. Переписка есть — канал ${dialog.channel === "INSTAGRAM" ? "Instagram" : "WhatsApp"}.` : ". Переписки пока нет."),
  };
}

/**
 * Итоги за неделю или месяц — теми же функциями, что и отчёты (§8).
 *
 * Прежде на «какая выручка за месяц?» ассистент отвечал числом за СЕГОДНЯ:
 * число верное, вопрос другой, и заметить подмену было нельзя.
 */
async function periodAnswer(
  ctx: AdminContext,
  period: "week" | "month",
  money: boolean,
): Promise<AdminAnswer> {
  const m = await getDashboardMetricsDb(ctx.companyId, period).catch(() => null);
  if (!m) return { text: "Не удалось посчитать период — попробуйте ещё раз." };
  const head = `${m.period.label} (${m.period.from.slice(0, 10)} — ${m.period.to.slice(0, 10)})`;
  if (money && !ctx.canSeeRevenue) {
    return { text: "Суммы показывает только сотрудник с доступом к выручке — у вашей учётки его нет." };
  }
  const moneyLine = ctx.canSeeRevenue
    ? ` Выручка ${rub(m.money.revenue)}, средний чек ${rub(m.money.avgCheck)}.`
    : "";
  /**
   * Неявки и неразобранные — той же функцией, что и отчёты (§8). «Неявок 0%»
   * без числа неразобранных читается как «неявок нет», хотя может означать
   * «никто ничего не отмечает».
   */
  const { from, to } = periodBounds(period);
  const attendance = await attendanceBetween(ctx.companyId, from, to).catch(() => null);
  const attendanceLine = attendance
    ? ` Неявок ${attendance.noShow}, отмен ${attendance.cancelled}, без отметки ${attendance.unmarked}.`
    : "";
  return {
    text:
      `${head}: обращений ${m.funnel.inquiries}, записались ${m.funnel.booked}, пришли ${m.funnel.arrived}.` +
      moneyLine +
      attendanceLine +
      " Разрезы по услугам и специалистам — в «Отчётах».",
  };
}

/**
 * Кто ждёт ответа. Считается тем же правилом, что сортирует список диалогов
 * (`waitingSince`): человек ждёт с ПЕРВОЙ своей реплики подряд, а не с
 * последней, — иначе три сообщения подряд выглядят как свежее обращение.
 */
async function waitingAnswer(ctx: AdminContext, now: Date): Promise<AdminAnswer> {
  const convs = await prisma.conversation.findMany({
    where: {
      companyId: ctx.companyId,
      deletedAt: null,
      isPractice: false,
      status: { not: "CLOSED" },
      channel: { not: "TELEGRAM" },
    },
    orderBy: { lastMessageAt: "desc" },
    take: 200,
    select: {
      id: true,
      contactName: true,
      patient: { select: { name: true } },
      messages: {
        where: { deletedAt: null, isDraft: false },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: { direction: true, createdAt: true },
      },
    },
  });

  const rows = convs
    .map((c) => {
      const ordered = [...c.messages].reverse().map((m) => ({ direction: m.direction, createdAt: m.createdAt }));
      const since = waitingSince(ordered);
      return since
        ? {
            name: c.patient?.name ?? c.contactName ?? "Без имени",
            minutes: Math.round((now.getTime() - since.getTime()) / 60_000),
          }
        : null;
    })
    .filter((r): r is { name: string; minutes: number } => r !== null)
    .sort((a, b) => b.minutes - a.minutes);

  if (rows.length === 0) return { text: "Никто не ждёт ответа — все переписки разобраны." };
  const long = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`);
  return {
    text:
      `Ждут ответа ${rows.length} ${people(rows.length)}:\n` +
      rows.slice(0, 15).map((r) => `• ${r.name} — ${long(r.minutes)}`).join("\n") +
      (rows.length > 15 ? `\n…и ещё ${rows.length - 15}` : ""),
  };
}

/** Очередь звонков — ровно та же, что на экране «Кому позвонить» (§8). */
async function callbacksAnswer(ctx: AdminContext): Promise<AdminAnswer> {
  const queue = await getCallbackQueue(ctx.companyId);
  if (queue.rows.length === 0) {
    return { text: "Очередь звонков пуста: у всех кандидатов есть будущая запись." };
  }
  const label: Record<string, string> = {
    COURSE_STALLED: "выпал из курса",
    COURSE_FINISHING: "курс на финише",
    NO_SHOW: "не пришли",
    SLEEPING: "давно не были",
  };
  const byKind = new Map<string, number>();
  for (const r of queue.rows) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
  return {
    text:
      `В очереди ${queue.rows.length}: ` +
      [...byKind].map(([kind, n]) => `${label[kind] ?? kind} — ${n}`).join("; ") +
      ".\nПервые: " +
      queue.rows.slice(0, 5).map((r) => r.patientName).join(", ") +
      ". Открыть целиком — раздел «Кому позвонить».",
  };
}

/** Новые пациенты — по тому же признаку, что и в отчётах: первое появление. */
async function newPatients(ctx: AdminContext, date: DateRef, now: Date): Promise<AdminAnswer> {
  const day = dayOf(date, now);
  const count = await prisma.patient.count({
    where: {
      companyId: ctx.companyId,
      deletedAt: null,
      // Карточки без известной даты первого обращения новыми не считаются (§8).
      firstSeenExact: true,
      firstSeenAt: { gte: day.start, lt: day.end },
    },
  });
  return {
    text:
      count === 0
        ? cap(`${date.label} новых пациентов не появилось.`)
        : cap(`${date.label} новых пациентов: ${count}.`),
  };
}

/**
 * Найти пациента по имени, как его написал администратор.
 *
 * Пишут в падеже: «Гульбаре», «Магомедовой», «Алиевой». Точное совпадение их
 * не находило вовсе — ассистент отвечал «пациента в базе нет» про человека,
 * который в базе есть. Ищем по корню слова (первые буквы), а окончание
 * отбрасываем: это тот же приём, которым в вопросе узнаётся врач.
 */
async function findPatients(
  companyId: string,
  name: string,
): Promise<{ id: string; name: string | null }[]> {
  const words = name
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3);
  if (words.length === 0) return [];
  const stems = words.map((w) => w.slice(0, Math.min(6, Math.max(3, w.length - 2))));
  const rows = await prisma.patient.findMany({
    where: {
      companyId,
      deletedAt: null,
      AND: stems.map((stem) => ({ name: { contains: stem, mode: "insensitive" as const } })),
    },
    take: 10,
    select: { id: true, name: true },
  });
  return rows;
}

async function patientAnswer(
  ctx: AdminContext,
  name: string,
  question: string,
): Promise<AdminAnswer> {
  const found = await findPatients(ctx.companyId, name);
  if (found.length === 0) {
    return { text: `Пациента «${name}» в базе не нашёл. Проверьте написание или откройте карточку.` };
  }
  if (found.length > 1) {
    return {
      text:
        `Таких несколько: ${found.map((p) => p.name ?? "без имени").join(", ")}. ` +
        "Назовите точнее — фамилию с именем.",
    };
  }
  const patient = found[0];

  /**
   * Врач спрашивает только про СВОИХ пациентов — та же область видимости, что
   * у карточки и у сводки диалога. Иначе чат стал бы обходным путём к чужой
   * истории болезни (§7).
   */
  if (ctx.canViewOthers === false) {
    const own = ctx.ownStaffId
      ? await prisma.appointment.findFirst({
          where: { companyId: ctx.companyId, patientId: patient.id, staffId: ctx.ownStaffId },
          select: { id: true },
        })
      : null;
    if (!own) {
      return {
        // Без глагола в роде: «не был» у пациентки читается как ошибка.
        text: `${patient.name ?? "Этот пациент"}: карточка вам не видна — этот пациент у вас на приёме не значится.`,
      };
    }
  }

  const [visits, courses] = await Promise.all([
    prisma.appointment.findMany({
      where: { companyId: ctx.companyId, patientId: patient.id, deletedAt: null },
      orderBy: { startAt: "desc" },
      take: 100,
      select: {
        startAt: true,
        status: true,
        revenue: true,
        revenueSource: true,
        primaryService: { select: { title: true } },
        staff: { select: { name: true } },
        services: { select: { service: { select: { title: true } } } },
      },
    }),
    prisma.course.findMany({
      where: { companyId: ctx.companyId, patientId: patient.id },
      select: {
        sessionsUsed: true,
        sessionsTotal: true,
        sessionsBooked: true,
        status: true,
        service: { select: { title: true } },
      },
    }),
  ]);

  const facts: AnswerFacts = {
    visits: visits.map((v) => ({
      status:
        v.status === "ARRIVED"
          ? "arrived"
          : v.status === "NO_SHOW"
            ? "no_show"
            : v.status === "CANCELLED"
              ? "cancelled"
              : "planned",
      at: v.startAt.toISOString(),
      amount: Number(v.revenue),
      paidEarlier: v.revenueSource === "PREPAID",
      service: v.primaryService?.title ?? "",
      doctor: v.staff?.name ?? "",
      title: visitTitle(
        v.services.map((s) => ({ title: s.service.title })),
        v.primaryService?.title ?? "приём",
      ),
    })),
    courses: courses.map((c) => ({
      title: c.service?.title ?? "курс",
      used: c.sessionsUsed,
      total: c.sessionsTotal,
      booked: c.sessionsBooked,
      // Закончен или нет — это поле самого курса; «выпал из графика» считает
      // экран по порогам клиники, и повторять то правило здесь нельзя (§8).
      status: c.status === "COMPLETED" ? "done" : "active",
    })),
    // Поэтому и вердикт о ритме ассистент не выносит — только счёт сеансов.
    courseStateKnown: false,
    truncated: visits.length >= 100,
  };

  const answer = answerAboutPatient(question, facts);

  /**
   * Вопрос общий — «что по нему?», «расскажи про пациента» — отвечаем сводкой,
   * а не «не знаю».
   *
   * «Не знаю» уместно там, где расчёта действительно нет; здесь он есть, просто
   * вопрос не назвал, какой именно. Собираем сводку ТЕМИ ЖЕ расчётами, чтобы
   * она не разошлась с ответом на точный вопрос.
   */
  if (!answer.known) {
    const parts = [
      answerAboutPatient("сколько раз приходил и на какую сумму", facts).text,
      answerAboutPatient("когда был последний раз", facts).text,
      answerAboutPatient("ближайшая запись", facts).text,
      answerAboutPatient("курсы", facts).text,
      answerAboutPatient("сколько неявок", facts).text,
    ];
    if (ctx.canSeeRevenue) parts.push(answerAboutPatient("должен ли что-то", facts).text);
    const summary = parts.join(" ");
    return { text: `${patient.name ?? "Пациент"}: ${ctx.canSeeRevenue ? summary : hideMoney(summary)}` };
  }

  return {
    text: `${patient.name ?? "Пациент"}: ${ctx.canSeeRevenue ? answer.text : hideMoney(answer.text)}`,
  };
}

/**
 * Подготовить рассылку: кому и что уйдёт.
 *
 * Ничего не отправляет. Список собирается из записей выбранного дня, и каждый
 * получатель назван по имени и времени приёма: администратор должен увидеть,
 * кому именно он сейчас напишет, — это единственная защита от «отправил не тем».
 */
export async function planBroadcast(
  ctx: AdminContext,
  input: {
    dayIso: string;
    staffId: string | null;
    serviceId: string | null;
    text: string;
    sendAtIso?: string | null;
  },
  now = new Date(),
): Promise<BroadcastPlan> {
  const day = dayOf({ offset: null, iso: input.dayIso, label: input.dayIso }, now);
  const appts = filtered(await apptsOfDay(ctx.companyId, day), input.staffId, input.serviceId)
    // Прошедшие приёмы не трогаем: предупреждать о переносе задним числом незачем.
    .filter((a) => a.status !== "NO_SHOW" && a.endAt > now);

  const patientIds = [...new Set(appts.map((a) => a.patientId).filter(Boolean))] as string[];
  const [phones, dialogs] = await Promise.all([
    patientIds.length
      ? prisma.patientPhone.findMany({
          where: { companyId: ctx.companyId, patientId: { in: patientIds } },
          select: { patientId: true },
        })
      : Promise.resolve([]),
    patientIds.length
      ? prisma.conversation.findMany({
          where: {
            companyId: ctx.companyId,
            patientId: { in: patientIds },
            deletedAt: null,
            NOT: { externalUserId: { startsWith: "local-" } },
          },
          select: { patientId: true, channel: true, isPractice: true },
        })
      : Promise.resolve([]),
  ]);
  const hasPhone = new Set(phones.map((p) => p.patientId));
  const byPatient = new Map(dialogs.map((d) => [d.patientId, d]));

  const seen = new Set<string>();
  const targets: BroadcastTarget[] = [];
  for (const a of appts) {
    if (!a.patientId || seen.has(a.patientId)) continue;
    seen.add(a.patientId);
    const dialog = byPatient.get(a.patientId);
    /**
     * Почему не уйдёт — говорим заранее, а не после нажатия. Instagram:
     * первым там пишет пациент, это ограничение Meta (§5). Тренировочная
     * переписка наружу не уходит вовсе.
     */
    const blocked = dialog?.isPractice
      ? "тренировочная переписка — наружу не уходит"
      : !dialog && !hasPhone.has(a.patientId)
        ? "нет номера в карточке"
        : dialog?.channel === "INSTAGRAM"
          ? "Instagram: первым пишет пациент"
          : null;
    targets.push({
      patientId: a.patientId,
      name: a.patientName,
      when: `${TIME.format(a.startAt)} · ${a.title}${input.staffId ? "" : `, ${a.staffName}`}`,
      blocked,
    });
  }

  const staffName = input.staffId
    ? ((await prisma.staff.findUnique({ where: { id: input.staffId }, select: { name: true } }))?.name ?? null)
    : null;

  return {
    text: input.text.trim(),
    targets,
    dayIso: input.dayIso,
    staffId: input.staffId,
    serviceId: input.serviceId,
    staffName,
    // Для человека — словами: «19 сентября». Машинная дата остаётся в dayIso,
    // по ней список пересчитывается при подтверждении.
    dateLabel: DAY_LABEL.format(day.start),
    kind: "broadcast",
    patientId: null,
    sendAtIso: input.sendAtIso ?? null,
    sendAtLabel: input.sendAtIso ? whenLabel(new Date(input.sendAtIso)) : null,
  };
}

async function broadcast(
  ctx: AdminContext,
  intent: Extract<AdminIntent, { kind: "broadcast" }>,
  staffName: string | null,
  now: Date,
): Promise<AdminAnswer> {
  if (!ctx.canMessage) {
    return { text: "Писать пациентам может сотрудник с таким правом — у вашей учётки его нет." };
  }
  /**
   * Текст: свой или заготовка под названную ситуацию. Имя врача в общей
   * рассылке не подставляем — получатели могут быть у разных специалистов;
   * оно появится, только если рассылка идёт по одному врачу.
   */
  const text = intent.text
    ? intent.text
    : intent.situation
      ? composeMessage(intent.situation, {
          doctorName: intent.staffId ? staffName : null,
          visitDay: intent.date.label,
          delayText: intent.delayText,
        })
      : "";
  if (!text) {
    return {
      text:
        "Скажите, что написать: своими словами после двоеточия — или ситуацией: «врач заболел», " +
        "«приём переносится», «напомни о записи», «клиника не работает». " +
        'Например: «отправь всем, кто записан завтра к Ирине Алилгаджиевне: Добрый день! Приём переносится».',
    };
  }

  const day = dayOf(intent.date, now);
  const plan = await planBroadcast(
    ctx,
    {
      dayIso: clinicDateKey(day.start),
      staffId: intent.staffId,
      serviceId: intent.serviceId,
      text,
      sendAtIso: intent.sendAtIso,
    },
    now,
  );

  const willSend = plan.targets.filter((t) => t.blocked === null);
  if (plan.targets.length === 0) {
    return {
      text: cap(`${who(staffName)}${intent.date.label} записей впереди нет — отправлять некому.`),
    };
  }
  return {
    text:
      `Готов отправить ${willSend.length} ${plural(willSend.length, "пациенту", "пациентам", "пациентам")} ` +
      `из ${plan.targets.length} записанных ${intent.date.label}${staffName ? ` · ${staffName}` : ""}. ` +
      (plan.sendAtLabel
        ? `Отправлю ${plan.sendAtLabel}. `
        : "") +
      "Проверьте текст и список — отправлю только после подтверждения.",
    plan,
  };
}

/** Суммы сотруднику без права на выручку не показываем (§9). */
function hideMoney(text: string): string {
  // Начинаем с цифры: иначе пробел перед суммой съедался и выходило
  // «По записям —сумма скрыта».
  return text.replace(/\d[\d\s\u00a0\u202f]*₽/g, "сумма скрыта");
}

function cap(text: string): string {
  return text.length > 0 ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}
