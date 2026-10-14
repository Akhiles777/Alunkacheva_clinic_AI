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
import { composeMessage, delayTextFrom, sendAtFrom, situationOf } from "@/lib/assistant/admin-compose";
import { EMPTY_MEMORY, asksSameAgain, resolveRef, type AdminMemory } from "@/lib/assistant/admin-memory";
import { intentFrom, maskPhones, understandAdmin } from "@/lib/assistant/admin-understand";
import { visitTitle } from "@/lib/visit-title";
import { answerAboutPatient, type AnswerFacts } from "@/lib/metrics/patient-answer";
import { explainUnmarked, UNMARKED_LABEL, type KnownMove, type OtherBooking } from "@/lib/metrics/unmarked";
import {
  ADMIN_ABILITIES,
  ASKS_BROADCAST as ASKS_WRITE,
  broadcastText,
  dateFrom,
  parseAdminQuestion,
  personName as personNameIn,
  staffIn,
  type AdminAnswer,
  type AdminIntent,
  type BroadcastPlan,
  type BroadcastTarget,
  type DateRef,
  type PlanAudience,
  LARGE_BROADCAST,
} from "@/lib/assistant/admin-intents";
import { matchSchool } from "@/lib/agent/promo";

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
    .filter((a) => (serviceId ? a.serviceIds.includes(serviceId) || sameKind(a.title, serviceId) : true));
}

/**
 * Вид услуги по строке прайса: «БОС-терапия» → «бос». Записи на соседние строки
 * того же вида («БОС-терапия, курс», «НАК + БОС») — та же услуга для вопроса
 * «кто завтра на БОС»: администратор спрашивает о виде, а не о строке прайса.
 */
const SERVICE_STEM = new Map<string, string>();
function rememberServiceStems(services: { id: string; title: string }[]): void {
  const GENERIC = /^(?:при[её]м|консультац|детск|взросл|первичн|повторн|курс|сеанс|прием)/iu;
  for (const s of services) {
    const word = s.title
      .toLowerCase()
      .replace(/ё/g, "е")
      .split(/[^a-zа-я0-9]+/u)
      .find((w) => w.length >= 3 && !GENERIC.test(w));
    if (word) SERVICE_STEM.set(s.id, word.slice(0, Math.max(3, Math.min(6, word.length - 2))));
  }
}
function sameKind(title: string, serviceId: string): boolean {
  const stem = SERVICE_STEM.get(serviceId);
  return Boolean(stem) && title.toLowerCase().replace(/ё/g, "е").includes(stem!);
}

/** Пациенты по номеру: последние десять цифр в любом из телефонов карточки. */
async function patientsByPhone(companyId: string, digits10: string): Promise<{ id: string; name: string | null }[]> {
  const rows = await prisma.patientPhone.findMany({
    where: { companyId, phone: { endsWith: digits10 }, patient: { deletedAt: null } },
    select: { patient: { select: { id: true, name: true } } },
    take: 5,
  });
  return [...new Map(rows.map((r) => [r.patient.id, r.patient])).values()];
}

/** Приписать к ответу оговорку («номер не нашёл, нашёл по имени»). */
function withNote(note: string, answer: AdminAnswer): AdminAnswer {
  return note ? { ...answer, text: `${note}${answer.text}` } : answer;
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
  /** Память разговора: о ком шла речь и какой список показан. */
  memory?: AdminMemory;
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

  const known = { staff, services };
  rememberServiceStems(services);

  /**
   * Понимает вопрос модель, считает код (`lib/assistant/admin-understand.ts`).
   * Модели уходит только сам вопрос с заглушкой вместо телефона; нет модели или
   * ответ не по форме — разбирают прежние правила.
   */
  const { phones } = maskPhones(question);
  const understood = await understandAdmin(question, known, now);
  let intent: AdminIntent = understood
    ? intentFrom(understood, known, now, (t) => sendAtFrom(t, now))
    : parseAdminQuestion(question, known, now);
  if (intent.kind === "patient" && !intent.question) intent = { ...intent, question };
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
   * Память разговора: «ей», «вторая», «нет, другой». Среди нескольких
   * подходящих ассистент не выбирает сам — список и вопрос.
   */
  const memory = ctx.memory ?? EMPTY_MEMORY;
  const ref = resolveRef(question, memory);
  if (ref.kind === "choose") {
    return chooseAmong(
      ref.candidates.map((c) => ({ id: c.id, name: c.name })),
      "Уточните, о ком речь",
      "Ответьте номером из списка или фамилией — сам я не выбираю.",
      memory.lastText,
    );
  }
  let refId = ref.kind === "patient" ? ref.patientId : null;
  if (!refId && understood?.refers_to_previous && memory.focus) refId = memory.focus;
  const picked = ref.kind === "patient" && (ref.how === "other" || ref.how === "ordinal" || ref.how === "name");

  /**
   * Телефон в вопросе — самый надёжный адрес (§4): «Предупреди Сумаю
   * (7988…)» находит ровно её, а не всех, в чьём имени есть «Сум».
   */
  const PERSONAL = new Set(["message_one", "patient", "contacts", "explain", "find", "unknown"]);
  let phoneNote = "";
  if (phones.length > 0 && PERSONAL.has(intent.kind)) {
    const byPhone = await patientsByPhone(ctx.companyId, phones[0]);
    if (byPhone.length === 1) refId = byPhone[0].id;
    else {
      const shown = `+7 ${phones[0].slice(0, 3)} ${phones[0].slice(3, 6)}-${phones[0].slice(6, 8)}-${phones[0].slice(8)}`;
      phoneNote = `Номер ${shown} в базе не нашёл. `;
      const hasName = "name" in intent && Boolean(intent.name);
      if (!hasName) {
        return { text: `${phoneNote}Проверьте цифры — или назовите пациента по имени и фамилии.` };
      }
    }
  }
  const named = "name" in intent && Boolean(intent.name);
  const byRef = refId !== null && (!named || phones.length > 0 || picked);
  const again = asksSameAgain(question) && memory.lastText ? memory.lastText : null;
  const writes =
    intent.kind === "message_one" ||
    (!understood && ASKS_WRITE.test(question) && !/(?<!\p{L})(?:всем|всех|все)(?!\p{L})/iu.test(question));
  const messageText = intent.kind === "message_one" ? intent.text : broadcastText(question);

  /**
   * Пациент известен без имени в реплике — по местоимению, выбору из списка
   * или телефону. «А ей напиши, что перенос на понедельник», «вторая», «нет,
   * другой» (после письма — то же письмо ей).
   */
  if (byRef && refId) {
    if (intent.kind === "explain") return explainAnswer(ctx, refId, now);
    if (writes || (picked && (again || memory.lastText))) {
      return withNote(
        phoneNote,
        await messageOne(
          ctx,
          {
            kind: "message_one",
            name: "",
            text: messageText || again || memory.lastText || "",
            situation: intent.kind === "message_one" ? intent.situation : situationOf(question),
            delayText: intent.kind === "message_one" ? intent.delayText : delayTextFrom(question),
            sendAtIso: intent.kind === "message_one" ? intent.sendAtIso : (sendAtFrom(question, now)?.toISOString() ?? null),
            date: intent.kind === "message_one" ? intent.date : dateFrom(question.toLowerCase(), now),
            staffId: null,
            serviceId: null,
          },
          now,
          refId,
          question,
        ),
      );
    }
    if (intent.kind === "contacts") return limited ? { text: ONLY_OWN } : contacts(ctx, "", refId);
    if (picked || intent.kind === "patient" || intent.kind === "unknown" || intent.kind === "find") {
      return patientAnswer(ctx, "", question, refId);
    }
  }

  /**
   * Просьба написать без адресата. «Отправь сразу, без подтверждения» — отказ:
   * без подтверждения не уходит ничего, ни при какой формулировке.
   */
  if (writes && !refId && !named) {
    if (/сразу|без\s+подтвержд|не\s+спрашива/iu.test(question)) {
      return {
        text:
          "Без подтверждения я не отправляю никогда — так устроено намеренно. Скажите, кому и что написать, " +
          "я покажу адресата и текст, а отправит кнопка «Отправить».",
      };
    }
    return { text: "Кому написать? Назовите пациента — имя, фамилию или номер телефона." };
  }

  /** «И Патимат тоже» — то же письмо другому адресату. */
  if ((intent.kind === "patient" || intent.kind === "message_one") && again && named) {
    return messageOne(
      ctx,
      {
        kind: "message_one",
        name: intent.name,
        text: again,
        situation: null,
        delayText: null,
        sendAtIso: null,
        date: dateFrom(question.toLowerCase(), now),
        staffId: null,
        serviceId: null,
      },
      now,
    );
  }

  /**
   * Врача назвали, но их двое с таким именем — переспрашиваем.
   *
   * Это единственное место, где ассистент отвечает вопросом: назвать не того
   * врача значит посчитать чужой день, а в рассылке — написать чужим людям.
   */
  const ambiguous = staffIn(understood ? (understood.staff ?? "") : question, staff);
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
      return withNote(phoneNote, await messageOne(ctx, intent, now, null, question));

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

    case "explain": {
      if (!intent.name) {
        return memory.focus
          ? explainAnswer(ctx, memory.focus, now)
          : { text: "О ком речь? Назовите пациента — подниму журнал ответов агента по его переписке." };
      }
      const found = await findPatients(ctx.companyId, intent.name);
      if (found.length === 0) return { text: `Пациента «${intent.name}» в базе не нашёл.` };
      if (found.length > 1) return chooseAmong(found, "Таких несколько");
      return explainAnswer(ctx, found[0].id, now);
    }

    case "find":
      return findAnswer(ctx, intent, now);

    case "medical_refusal":
      return {
        text:
          "На медицинские вопросы я не отвечаю своими словами — ни вам, ни пациенту. Если ответ клиники " +
          "заведён в справочнике, агент отвечает им дословно; если нет — вопрос решает врач. " +
          "Могу найти пациента или его визиты — скажите, кого.",
      };

    case "child_refusal":
      return {
        text:
          "Второго ребёнка к школе я не привязываю — это решение администратора. В «Диалогах» откройте " +
          "переписку: в строке акции «Ещё ребёнок» — система покажет, кто из семьи уже привязан, и спросит.",
      };


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
  refId: string | null = null,
  /** Поручение администратора дословно — по нему проверяются числа в тексте письма. */
  question: string | null = null,
): Promise<AdminAnswer> {
  if (!ctx.canMessage) {
    return { text: "Писать пациентам может сотрудник с таким правом — у вашей учётки его нет." };
  }

  let found = await findPatients(ctx.companyId, intent.name, refId);
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
    return chooseAmong(
      found,
      "Таких пациентов несколько",
      "Ответьте номером из списка или фамилией — или скажите, к какому врачу и на какой день он записан.",
      text0(intent),
    );
  }

  const patient = found[0];
  const appt = booked.get(patient.id) ?? null;

  /**
   * Текст: свой, если администратор его продиктовал, иначе — заготовка
   * клиники под названную ситуацию. Сочинять от себя нельзя: это письмо уйдёт
   * от имени клиники.
   */
  const draft = intent.text
    ? intent.text
    : intent.situation
      ? composeMessage(intent.situation, {
          doctorName: appt?.staffName ?? null,
          visitTime: appt ? TIME.format(appt.startAt) : null,
          visitDay: appt ? intent.date.label : null,
          delayText: intent.delayText,
        })
      : "";
  /**
   * {{date}}, {{time}}, {{doctor}}, {{service}} — из БЛИЖАЙШЕЙ записи пациента,
   * {{name}} — его имя. Текст сочиняет модель по поручению, но фактов у неё нет:
   * их подставляет код, и записи впереди нет — так и говорим, а не отправляем
   * письмо с дырой (как с шаблонами WhatsApp).
   */
  const filled = draft ? await fillFacts(ctx.companyId, patient, draft, now) : { text: "", missing: [] as string[] };
  if (filled.missing.length > 0) {
    return {
      memory: { focus: patient.id },
      text:
        `${patient.name ?? "Пациент"}: в тексте нужны ${filled.missing.join(", ")}, а записи впереди у пациента нет. ` +
        "Напишите текст сами после двоеточия — или уточните, о какой записи речь.",
    };
  }
  const text = filled.text;
  /** Число, которого не было в поручении и нет в записи, — повод перечитать текст. */
  const strangeNumbers = question ? numbersNotIn(text, `${question} ${filled.facts ?? ""}`) : [];
  if (!text) {
    return {
      memory: { focus: patient.id },
      text:
        `${patient.name ?? "Пациент"} — нашёл. Теперь скажите, что написать: ` +
        "или своими словами после двоеточия, или ситуацией — «врач задерживается», " +
        "«приём переносится», «врач заболел», «напомни о записи», «клиника не работает».",
    };
  }

  const delivery = (await deliveryOf(ctx.companyId, [patient.id], now)).get(patient.id)!;
  const dialog = delivery.hasDialog;
  const blocked = delivery.blocked;

  /**
   * Отложенную отправку исполняет сервер по переписке (`DialogTask`), значит
   * без переписки её не поставить. Говорим об этом прямо, а не молчим: иначе
   * администратор будет ждать сообщения, которого никто не отправит.
   */
  const scheduled = intent.sendAtIso ? new Date(intent.sendAtIso) : null;
  const cannotSchedule = scheduled !== null && !dialog;

  const when = appt
    ? `${intent.date.label} в ${TIME.format(appt.startAt)}, ${appt.title}`
    : await nearestBookingLabel(ctx.companyId, patient.id, now);
  return {
    text:
      `${patient.name ?? "Пациент"} — ${when}. ` +
      (blocked
        ? `Отправить не получится: ${blocked}.`
        : cannotSchedule
          ? "Отложить не получится: переписки с этим человеком ещё нет, а завести её можно только отправкой. Могу отправить сразу — подтвердите."
          : scheduled
            ? `Отправлю ${whenLabel(scheduled)} — проверьте текст и адресата.`
            : "Проверьте текст и адресата — отправлю после подтверждения.") +
      (strangeNumbers.length ? ` В тексте есть ${strangeNumbers.join(", ")} — этого не было в вашем поручении, перечитайте.` : ""),
    plan: {
      kind: "one",
      text,
      targets: [
        {
          patientId: patient.id,
          name: patient.name ?? "Пациент",
          when,
          blocked,
          contact: delivery.contact,
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
    memory: { focus: patient.id, lastText: text },
  };
}

/**
 * Куда уйдёт сообщение и уйдёт ли — для каждого получателя ДО отправки.
 *
 * Instagram: свободный текст Meta пропускает только в 24-часовом окне после
 * сообщения пациента (§5). Открыто — пишем, закрыто — говорим словами заранее.
 * У WhatsApp через Green API окна нет: там работает сессия номера клиники.
 */
export async function deliveryOf(
  companyId: string,
  patientIds: string[],
  now: Date = new Date(),
): Promise<Map<string, { contact: string; blocked: string | null; hasDialog: boolean }>> {
  const out = new Map<string, { contact: string; blocked: string | null; hasDialog: boolean }>();
  if (patientIds.length === 0) return out;
  const [phones, dialogs] = await Promise.all([
    prisma.patientPhone.findMany({
      where: { companyId, patientId: { in: patientIds } },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      select: { patientId: true, phone: true },
    }),
    prisma.conversation.findMany({
      where: { companyId, patientId: { in: patientIds }, deletedAt: null, NOT: { externalUserId: { startsWith: "local-" } } },
      orderBy: { lastMessageAt: "desc" },
      select: {
        patientId: true,
        channel: true,
        isPractice: true,
        messages: { where: { direction: "IN" }, orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } },
      },
    }),
  ]);
  for (const id of patientIds) {
    const phone = phones.find((p) => p.patientId === id)?.phone ?? null;
    const dialog = dialogs.find((d) => d.patientId === id) ?? null;
    const channel = dialog ? CHANNEL_NAME[dialog.channel] ?? dialog.channel : phone ? "WhatsApp" : null;
    const lastIn = dialog?.messages[0]?.createdAt ?? null;
    const igOpen = lastIn !== null && now.getTime() - lastIn.getTime() < 24 * 3600_000;
    const blocked = dialog?.isPractice
      ? "тренировочная переписка — наружу не уходит"
      : !dialog && !phone
        ? "нет номера в карточке"
        : dialog?.channel === "INSTAGRAM" && !igOpen
          ? "Instagram: окно ответа 24 ч закрыто — свободный текст не уйдёт"
          : null;
    out.set(id, {
      contact: [phone, channel].filter(Boolean).join(" · ") || "контактов нет",
      blocked,
      hasDialog: dialog !== null,
    });
  }
  return out;
}

const CHANNEL_NAME: Record<string, string> = { WHATSAPP: "WhatsApp", INSTAGRAM: "Instagram", TELEGRAM: "Telegram" };

/**
 * Несколько подходящих — показываем нумерованный список и НИЧЕГО не делаем:
 * выбирает администратор, номером или фамилией (`admin-memory`).
 */
function chooseAmong(
  found: { id: string; name: string | null }[],
  lead: string,
  tail = "Ответьте номером из списка или фамилией.",
  lastText: string | null = null,
): AdminAnswer {
  const list = found.slice(0, 15).map((p) => ({ id: p.id, name: p.name ?? "без имени" }));
  return {
    text: `${lead}:\n${list.map((p, i) => `${i + 1}. ${p.name}`).join("\n")}\n${tail}`,
    // Текст письма живёт, только пока ждём выбора адресата для него.
    memory: { focus: null, candidates: list, lastText },
  };
}

/** Текст письма, если администратор его уже продиктовал: при уточнении адресата он не теряется. */
function text0(intent: Extract<AdminIntent, { kind: "message_one" }>): string | null {
  return intent.text || null;
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
async function contacts(ctx: AdminContext, name: string, refId: string | null = null): Promise<AdminAnswer> {
  const found = await findPatients(ctx.companyId, name, refId);
  if (found.length === 0) return { text: `Пациента «${name}» в базе не нашёл.` };
  if (found.length > 1) return chooseAmong(found, "Таких несколько");
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
    return { text: `${found[0].name ?? "Пациент"}: номера в карточке нет.`, memory: { focus: found[0].id } };
  }
  return {
    memory: { focus: found[0].id },
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
  /** Пациент из памяти разговора («ей», «вторая»): ищем его, а не по имени. */
  refId: string | null = null,
): Promise<{ id: string; name: string | null }[]> {
  if (refId) {
    const one = await prisma.patient.findFirst({
      where: { id: refId, companyId, deletedAt: null },
      select: { id: true, name: true },
    });
    return one ? [one] : [];
  }
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
    take: 200,
    select: { id: true, name: true },
  });
  /**
   * Только с НАЧАЛА слова: «Сумая» не находит «Касумову» и «Гаджикасумову» —
   * подстрока «сум» стоит у них в середине фамилии (живой случай, 14 октября).
   */
  const norm = (t: string) => t.toLowerCase().replace(/ё/g, "е");
  const hits = rows.filter((r) => {
    const parts = norm(r.name ?? "").split(/[^\p{L}]+/u);
    return stems.every((st) => parts.some((w) => w.startsWith(norm(st))));
  });
  return hits.slice(0, 15);
}

async function patientAnswer(
  ctx: AdminContext,
  name: string,
  question: string,
  refId: string | null = null,
): Promise<AdminAnswer> {
  const found = await findPatients(ctx.companyId, name, refId);
  if (found.length === 0) {
    return { text: `Пациента «${name}» в базе не нашёл. Проверьте написание или откройте карточку.` };
  }
  if (found.length > 1) return chooseAmong(found, "Таких несколько");
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
    return {
      text: `${patient.name ?? "Пациент"}: ${ctx.canSeeRevenue ? summary : hideMoney(summary)}`,
      memory: { focus: patient.id },
    };
  }

  return {
    text: `${patient.name ?? "Пациент"}: ${ctx.canSeeRevenue ? answer.text : hideMoney(answer.text)}`,
    memory: { focus: patient.id },
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
    audience?: PlanAudience | null;
  },
  now = new Date(),
): Promise<BroadcastPlan> {
  if (input.audience) return planAudience(ctx, input.audience, input.text, input.sendAtIso ?? null, now);
  const day = dayOf({ offset: null, iso: input.dayIso, label: input.dayIso }, now);
  const appts = filtered(await apptsOfDay(ctx.companyId, day), input.staffId, input.serviceId)
    // Прошедшие приёмы не трогаем: предупреждать о переносе задним числом незачем.
    .filter((a) => a.status !== "NO_SHOW" && a.endAt > now);

  const patientIds = [...new Set(appts.map((a) => a.patientId).filter(Boolean))] as string[];
  const delivery = await deliveryOf(ctx.companyId, patientIds, now);

  const seen = new Set<string>();
  const targets: BroadcastTarget[] = [];
  for (const a of appts) {
    if (!a.patientId || seen.has(a.patientId)) continue;
    seen.add(a.patientId);
    // Почему не уйдёт — говорим заранее, а не после нажатия (`deliveryOf`).
    const d = delivery.get(a.patientId)!;
    targets.push({
      patientId: a.patientId,
      name: a.patientName,
      when: `${TIME.format(a.startAt)} · ${a.title}${input.staffId ? "" : `, ${a.staffName}`}`,
      blocked: d.blocked,
      contact: d.contact,
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
    audience: null,
    large: targets.filter((t) => t.blocked === null).length > LARGE_BROADCAST,
  };
}

/**
 * Получатели не по записи на день, а по условию: курс, школа, кто был за
 * период. Условие обязательно — «всем пациентам» без него не готовим (ТЗ 4B.5).
 */
async function planAudience(
  ctx: AdminContext,
  audience: PlanAudience,
  text: string,
  sendAtIso: string | null,
  now: Date,
): Promise<BroadcastPlan> {
  const why = new Map<string, string>();
  if (audience.kind === "course") {
    const rows = await prisma.course.findMany({
      where: { companyId: ctx.companyId, status: "ACTIVE", ...(await courseServiceWhere(audience.serviceId)) },
      select: { patientId: true, sessionsUsed: true, sessionsTotal: true, service: { select: { title: true } } },
    });
    for (const r of rows) if (!why.has(r.patientId)) why.set(r.patientId, `${r.service.title} · ${r.sessionsUsed}/${r.sessionsTotal}`);
  } else if (audience.kind === "school") {
    const rows = await prisma.partnerAttribution.findMany({
      where: { companyId: ctx.companyId, schoolId: audience.schoolId, removedAt: null },
      select: { patientId: true, note: true },
    });
    for (const r of rows) if (!why.has(r.patientId)) why.set(r.patientId, `от школы${r.note ? ` · ${r.note}` : ""}`);
  } else {
    const rows = await prisma.appointment.findMany({
      where: {
        companyId: ctx.companyId,
        deletedAt: null,
        status: "ARRIVED",
        startAt: { gte: new Date(audience.fromIso), lt: new Date(audience.toIso) },
        ...(audience.staffId ? { staffId: audience.staffId } : {}),
        ...(audience.serviceId ? { services: { some: { serviceId: audience.serviceId } } } : {}),
      },
      orderBy: { startAt: "desc" },
      select: { patientId: true, startAt: true },
    });
    for (const r of rows) if (!why.has(r.patientId)) why.set(r.patientId, `был(а) ${DAY_LABEL.format(r.startAt)}`);
  }
  const ids = [...why.keys()];
  const [patients, delivery] = await Promise.all([
    prisma.patient.findMany({ where: { companyId: ctx.companyId, id: { in: ids }, deletedAt: null }, select: { id: true, name: true } }),
    deliveryOf(ctx.companyId, ids, now),
  ]);
  const targets: BroadcastTarget[] = patients
    .map((p) => {
      const d = delivery.get(p.id)!;
      return { patientId: p.id, name: p.name ?? "без имени", when: why.get(p.id) ?? "", blocked: d.blocked, contact: d.contact };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
  return {
    kind: "broadcast",
    text: text.trim(),
    targets,
    dayIso: clinicDateKey(now),
    staffId: null,
    serviceId: null,
    staffName: null,
    dateLabel: audience.label,
    patientId: null,
    sendAtIso,
    sendAtLabel: sendAtIso ? whenLabel(new Date(sendAtIso)) : null,
    audience,
    large: targets.filter((t) => t.blocked === null).length > LARGE_BROADCAST,
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
  const draft = intent.text
    ? intent.text
    : intent.situation
      ? composeMessage(intent.situation, {
          doctorName: intent.staffId ? staffName : null,
          visitDay: intent.date.label,
          delayText: intent.delayText,
        })
      : "";
  // Общий текст на всех: заготовок «на каждого» у рассылки нет — вырезаем.
  const text = draft.replace(/\{\{[^}]*\}\}/g, "").replace(/\s+([,!.])/g, "$1").replace(/[ \t]{2,}/g, " ").trim();
  if (!text) {
    return {
      text:
        "Скажите, что написать: своими словами после двоеточия — или ситуацией: «врач заболел», " +
        "«приём переносится», «напомни о записи», «клиника не работает». " +
        'Например: «отправь всем, кто записан завтра к Ирине Алилгаджиевне: Добрый день! Приём переносится».',
    };
  }

  /**
   * Рассылка «всем» без условия не готовится никогда: нужен критерий — запись,
   * курс, услуга с периодом, школа. Промах в такой рассылке виден всей базе.
   */
  if (intent.audience === "none") {
    return {
      text:
        "Всем пациентам без условия я не рассылаю. Скажите, кому: записанным на день " +
        "(«всем, кто записан завтра к Ирине»), тем, кто на курсе («всем на БОС-курсе»), " +
        "кто был за период («всем, кто был на остеопатии в сентябре») или от школы («всем от школы Росток»).",
    };
  }
  if (intent.audience !== "booked") {
    const audience = await audienceFor(ctx, intent, now);
    if ("text" in audience) return audience;
    const plan = await planBroadcast(ctx, { dayIso: clinicDateKey(now), staffId: null, serviceId: null, text, sendAtIso: intent.sendAtIso, audience }, now);
    return broadcastSummary(plan, audience.label);
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
      largeNote(plan) +
      "Проверьте текст и список — отправлю только после подтверждения.",
    plan,
  };
}

function largeNote(plan: BroadcastPlan): string {
  return plan.large
    ? `Получателей больше ${LARGE_BROADCAST} — перед отправкой нужно отдельное подтверждение, а уходить сообщения будут с паузой, не залпом. `
    : "";
}

function broadcastSummary(plan: BroadcastPlan, label: string): AdminAnswer {
  const willSend = plan.targets.filter((t) => t.blocked === null);
  if (plan.targets.length === 0) return { text: `По условию «${label}» никого не нашёл — отправлять некому.` };
  return {
    text:
      `Готов отправить ${willSend.length} ${plural(willSend.length, "пациенту", "пациентам", "пациентам")} ` +
      `из ${plan.targets.length} · ${label}. ` +
      (plan.sendAtLabel ? `Отправлю ${plan.sendAtLabel}. ` : "") +
      largeNote(plan) +
      "Проверьте текст и список — отправлю только после подтверждения.",
    plan,
  };
}

/** Условие рассылки из слов администратора — или вопрос, если условие не однозначно. */
async function audienceFor(
  ctx: AdminContext,
  intent: Extract<AdminIntent, { kind: "broadcast" }>,
  now: Date,
): Promise<PlanAudience | { text: string }> {
  const serviceTitle = intent.serviceId
    ? ((await prisma.service.findUnique({ where: { id: intent.serviceId }, select: { title: true } }))?.title ?? null)
    : null;
  if (intent.audience === "course") {
    return { kind: "course", serviceId: intent.serviceId, label: serviceTitle ? `на курсе «${serviceTitle}»` : "на любом действующем курсе" };
  }
  if (intent.audience === "school") {
    const schools = await prisma.partnerSchool.findMany({
      where: { companyId: ctx.companyId, isActive: true },
      select: { id: true, name: true },
    });
    const m = matchSchool(intent.schoolText ?? "", schools);
    if (m.kind === "match") {
      return { kind: "school", schoolId: m.schoolId, label: `от школы ${schools.find((s) => s.id === m.schoolId)?.name ?? ""}` };
    }
    return {
      text: schools.length
        ? `Какой школе? ${m.kind === "ambiguous" ? "Подходят несколько: " : "Не узнал название. Есть: "}` +
          `${(m.kind === "ambiguous" ? schools.filter((s) => m.schoolIds.includes(s.id)) : schools).map((s) => s.name).join(", ")}.`
        : "Школ-партнёров пока нет — их заводят на экране «Акции».",
    };
  }
  // «Кто был»: нужен период — иначе это вся база за всё время.
  let range: { start: Date; end: Date } | null = null;
  let periodLabel = "";
  if (intent.month !== null) {
    const y = Number(clinicDateKey(now).slice(0, 4));
    const year = intent.month > now.getMonth() ? y - 1 : y;
    const start = startOfClinicDay(new Date(Date.UTC(year, intent.month, 1, 12)));
    const end = startOfClinicDay(new Date(Date.UTC(intent.month === 11 ? year + 1 : year, (intent.month + 1) % 12, 1, 12)));
    range = { start, end };
    periodLabel = `в ${MONTH_PREP[intent.month]}`;
  } else if (intent.period && intent.period !== "month") {
    range = periodRange(intent.period, now);
    periodLabel = PERIOD_WORD[intent.period];
  }
  if (!range) {
    return { text: "За какой период? Например: «всем, кто был на остеопатии в сентябре» или «на прошлой неделе»." };
  }
  return {
    kind: "visited",
    fromIso: range.start.toISOString(),
    toIso: range.end.toISOString(),
    serviceId: intent.serviceId,
    staffId: intent.staffId,
    label: `кто был${serviceTitle ? ` на «${serviceTitle}»` : ""} ${periodLabel}`,
  };
}

const MONTH_PREP = ["январе", "феврале", "марте", "апреле", "мае", "июне", "июле", "августе", "сентябре", "октябре", "ноябре", "декабре"];
const PERIOD_WORD = { last_week: "на прошлой неделе", this_week: "на этой неделе", last_month: "в прошлом месяце", this_month: "в этом месяце" } as const;

/** Суммы сотруднику без права на выручку не показываем (§9). */
function hideMoney(text: string): string {
  // Начинаем с цифры: иначе пробел перед суммой съедался и выходило
  // «По записям —сумма скрыта».
  return text.replace(/\d[\d\s\u00a0\u202f]*₽/g, "сумма скрыта");
}

function cap(text: string): string {
  return text.length > 0 ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

// ─────────────────────────────────────────────── «зачем агент это написал»

const AT = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});

const OUTCOME_WORD: Record<string, string> = {
  OK: "ответ ушёл",
  TIMEOUT: "модель не успела ответить",
  PROVIDER_ERROR: "сбой у провайдера модели",
  EMPTY_RESPONSE: "модель ответила пустотой",
  ESCALATED: "агент позвал человека",
  SUPPRESSED: "агент намеренно промолчал",
};

/**
 * Основание последнего ответа в переписке пациента — из журнала попыток.
 *
 * Только факты: кто написал (агент, сотрудник, отправка через ассистента),
 * на какую реплику пациента, какие записи справочника легли в ответ, чем
 * кончилась попытка. Журнала нет — так и говорим: «не знаю, вот что в логе».
 * Придуманное объяснение хуже честного «не знаю»: по нему примут решение.
 */
async function explainAnswer(ctx: AdminContext, patientId: string, now: Date): Promise<AdminAnswer> {
  void now;
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, companyId: ctx.companyId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!patient) return { text: "Пациента не нашёл." };
  if (ctx.canViewOthers === false) {
    const own = ctx.ownStaffId
      ? await prisma.appointment.findFirst({ where: { companyId: ctx.companyId, patientId, staffId: ctx.ownStaffId }, select: { id: true } })
      : null;
    if (!own) return { text: `${patient.name ?? "Пациент"}: переписка вам не видна — этот пациент у вас на приёме не значится.` };
  }
  const name = patient.name ?? "Пациент";
  const last = await prisma.message.findFirst({
    where: { companyId: ctx.companyId, direction: "OUT", conversation: { patientId, deletedAt: null } },
    orderBy: { createdAt: "desc" },
    select: { id: true, body: true, authorType: true, authorId: true, createdAt: true, conversationId: true, viaPlatform: true },
  });
  if (!last) return { text: `${name}: в переписке нет ни одного нашего сообщения.`, memory: { focus: patientId } };

  const quote = last.body.length > 160 ? `${last.body.slice(0, 160)}…` : last.body;
  const head = `${name}, ${AT.format(last.createdAt)}: «${quote}»`;
  if (last.authorType === "STAFF") {
    const who = last.authorId
      ? ((await prisma.staffUser.findUnique({ where: { id: last.authorId }, select: { name: true } }))?.name ?? "сотрудник")
      : null;
    return {
      memory: { focus: patientId },
      text:
        `${head}\n\nЭто написал не агент, а ${who ?? "сотрудник с телефона клиники"}` +
        (who ? " — из платформы (вручную или через меня, по подтверждению сотрудника)." : ".") +
        " Основание у такого ответа — решение человека; в журнале агента его нет.",
    };
  }

  const [runs, before] = await Promise.all([
    prisma.agentRun.findMany({
      where: { companyId: ctx.companyId, conversationId: last.conversationId, messageId: last.id },
      orderBy: { triggeredAt: "asc" },
      select: { outcome: true, knowledgeEntryIds: true, errorText: true, model: true },
    }),
    prisma.message.findFirst({
      where: { conversationId: last.conversationId, direction: "IN", createdAt: { lte: last.createdAt } },
      orderBy: { createdAt: "desc" },
      select: { body: true },
    }),
  ]);
  const asked = before?.body ? `Пациент перед этим написал: «${before.body.length > 160 ? `${before.body.slice(0, 160)}…` : before.body}».` : "Входящей реплики перед ответом не нашёл.";
  if (runs.length === 0) {
    return {
      memory: { focus: patientId },
      text:
        `${head}\n\n${asked}\nНе знаю, почему агент ответил именно так: в журнале попыток для этого ` +
        "сообщения записей нет (так бывает у ответов до октября 2026 и у служебных сообщений). Причину не придумываю.",
    };
  }
  const ids = [...new Set(runs.flatMap((r) => r.knowledgeEntryIds))];
  const entries = ids.length
    ? await prisma.knowledgeEntry.findMany({ where: { companyId: ctx.companyId, id: { in: ids } }, select: { topic: true, promoId: true } })
    : [];
  const lastRun = runs[runs.length - 1];
  const lines = [head, "", asked];
  const topic = (e: { topic: string; promoId: string | null }) => `«${e.topic}»${e.promoId ? " (запись акции)" : ""}`;
  lines.push(
    entries.length === 1
      ? `Ответ — дословно запись справочника ${topic(entries[0])}.`
      : entries.length > 1
        ? `Модель отвечала по справке из ${entries.length} записей (в том числе ${entries.slice(0, 4).map(topic).join(", ")}). ` +
          "Какой именно фразой она воспользовалась, журнал не говорит — угадывать не буду."
        : "Записей справочника за этим ответом в журнале нет — значит, текст собран правилами агента (цены из прайса, шаги записи, расписание) или моделью без опоры на справку.",
  );
  lines.push(`Исход попытки: ${OUTCOME_WORD[lastRun.outcome] ?? lastRun.outcome}${lastRun.model ? ` · модель ${lastRun.model}` : ""}.`);
  if (runs.length > 1) lines.push(`Попыток было ${runs.length}: первые не удались, ответ ушёл с последней.`);
  if (lastRun.errorText) lines.push(`В журнале: ${lastRun.errorText}`);
  return { memory: { focus: patientId }, text: lines.join("\n") };
}

// ─────────────────────────────────────────────── поиск пациентов

const FIND_LIMIT = 15;

/**
 * Найти пациентов гибко: часть имени, любой из телефонов, врач, услуга,
 * период, курс. Один — справка и он в фокусе разговора; несколько — список, и
 * выбирает администратор. Врач без доступа к чужим видит только своих.
 */
async function findAnswer(
  ctx: AdminContext,
  intent: Extract<AdminIntent, { kind: "find" }>,
  now: Date,
): Promise<AdminAnswer> {
  const limited = ctx.canViewOthers === false;
  const range = intent.date
    ? dayOf(intent.date, now)
    : intent.period
      ? periodRange(intent.period, now)
      : null;
  const staffId = limited ? (ctx.ownStaffId ?? "__none__") : intent.staffId;
  // «С БОС-курсом» — услуга называет курс, а не визит: в фильтр визитов не идёт.
  const visitService = intent.course ? null : intent.serviceId;
  const visitFilter =
    range || staffId || visitService
      ? {
          appointments: {
            some: {
              deletedAt: null,
              ...(range ? { startAt: { gte: range.start, lt: range.end } } : {}),
              ...(staffId ? { staffId } : {}),
              ...(visitService ? { services: { some: { serviceId: visitService } } } : {}),
            },
          },
        }
      : {};
  const words = (intent.name ?? "")
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .map((w) => w.slice(0, Math.min(6, Math.max(3, w.length - 2))));
  if (!words.length && !intent.phoneDigits && !intent.course && !range && !intent.staffId && !intent.serviceId) {
    return { text: "Кого искать? Назовите имя или его часть, телефон, услугу, врача, курс или период — например, «найди Диану с прошлой недели»." };
  }
  const rows = await prisma.patient.findMany({
    where: {
      companyId: ctx.companyId,
      deletedAt: null,
      AND: [
        ...words.map((w) => ({ name: { contains: w, mode: "insensitive" as const } })),
        ...(intent.phoneDigits ? [{ phones: { some: { phone: { contains: intent.phoneDigits.slice(-10) } } } }] : []),
        ...(intent.course
          ? [{ courses: { some: { status: "ACTIVE" as const, ...(await courseServiceWhere(intent.serviceId)) } } }]
          : []),
        visitFilter,
      ],
    },
    orderBy: { lastVisitAt: { sort: "desc", nulls: "last" } },
    take: FIND_LIMIT + 1,
    select: { id: true, name: true, lastVisitAt: true, phones: { take: 1, orderBy: { isPrimary: "desc" }, select: { phone: true } } },
  });
  if (rows.length === 0) return { text: "Никого не нашёл по этим условиям. Попробуйте часть имени или последние цифры телефона." };
  if (rows.length === 1) {
    const p = rows[0];
    const answer = await patientAnswer(ctx, "", "что по нему", p.id);
    return { text: answer.text, memory: { focus: p.id, candidates: [], lastText: null } };
  }
  const shown = rows.slice(0, FIND_LIMIT);
  const list = shown.map((p) => ({ id: p.id, name: p.name ?? "без имени" }));
  const lines = shown.map(
    (p, i) =>
      `${i + 1}. ${p.name ?? "без имени"}` +
      (p.phones[0] ? ` · …${p.phones[0].phone.slice(-4)}` : "") +
      (p.lastVisitAt ? ` · был(а) ${DAY_LABEL.format(p.lastVisitAt)}` : ""),
  );
  return {
    text:
      `Нашёл ${rows.length > FIND_LIMIT ? `больше ${FIND_LIMIT}, показываю первых ${FIND_LIMIT}` : rows.length}:\n${lines.join("\n")}\n` +
      "Кого из них? Ответьте номером или фамилией — сам я не выбираю.",
    memory: { focus: null, candidates: list, lastText: null },
  };
}

/** Границы периода словами — по суткам клиники. */
function periodRange(
  period: "last_week" | "this_week" | "last_month" | "this_month",
  now: Date,
): { start: Date; end: Date } {
  const today = startOfClinicDay(now);
  const dow = (new Date(today.getTime() + 12 * 3600_000).getUTCDay() + 6) % 7; // пн = 0
  const day = 24 * 3600_000;
  if (period === "this_week") return { start: new Date(today.getTime() - dow * day), end: new Date(today.getTime() + day) };
  if (period === "last_week") {
    const start = new Date(today.getTime() - (dow + 7) * day);
    return { start, end: new Date(start.getTime() + 7 * day) };
  }
  const key = clinicDateKey(now);
  const [y, m] = key.split("-").map(Number);
  const monthStart = (yy: number, mm: number) => startOfClinicDay(new Date(Date.UTC(yy, mm, 1, 12)));
  if (period === "this_month") return { start: monthStart(y, m - 1), end: new Date(today.getTime() + day) };
  return { start: monthStart(m === 1 ? y - 1 : y, m === 1 ? 11 : m - 2), end: monthStart(y, m - 1) };
}

/**
 * Курс по ВИДУ услуги, а не по строке прайса: курсы привязаны к своей строке
 * («БОС-терапия» курсовая), а в вопросе находится первая похожая. «С
 * БОС-курсом» — все курсы, где в названии есть «БОС».
 */
async function courseServiceWhere(serviceId: string | null): Promise<{ service?: { title: { contains: string; mode: "insensitive" } } }> {
  if (!serviceId) return {};
  const title = (await prisma.service.findUnique({ where: { id: serviceId }, select: { title: true } }))?.title ?? "";
  const stem = title.split(/[\s,+()-]+/u).find((w) => w.length >= 3) ?? title;
  return stem ? { service: { title: { contains: stem, mode: "insensitive" } } } : {};
}

// ─────────────────────────────────────────────── факты для письма

const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

/** Имя для обращения: «Мамедова Сумайсат Гасангусейновна» → «Сумайсат». */
function firstName(full: string | null): string | null {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return parts.length >= 2 ? parts[1] : parts[0];
}

async function fillFacts(
  companyId: string,
  patient: { id: string; name: string | null },
  draft: string,
  now: Date,
): Promise<{ text: string; missing: string[]; facts?: string }> {
  const needs = (k: string) => draft.includes(`{{${k}}}`);
  const missing: string[] = [];
  let text = draft;
  const name = firstName(patient.name);
  text = text.replace(/\{\{name\}\}/g, name ?? "").replace(/,\s*!/g, "!").replace(/\s+,/g, ",");
  let facts = "";
  if (needs("date") || needs("time") || needs("doctor") || needs("service")) {
    const next = await prisma.appointment.findFirst({
      where: { companyId, patientId: patient.id, deletedAt: null, startAt: { gte: now }, status: { notIn: ["CANCELLED", "NO_SHOW"] } },
      orderBy: { startAt: "asc" },
      select: {
        startAt: true,
        staff: { select: { name: true } },
        primaryService: { select: { title: true } },
        services: { select: { service: { select: { title: true } } } },
      },
    });
    if (!next) {
      for (const [k, w] of [["date", "дата"], ["time", "время"], ["doctor", "врач"], ["service", "услуга"]] as const) {
        if (needs(k)) missing.push(`${w} записи`);
      }
      return { text, missing };
    }
    const key = clinicDateKey(next.startAt);
    const [, m, d] = key.split("-").map(Number);
    const date = `${d} ${MONTHS_GEN[m - 1]}`;
    const time = TIME.format(next.startAt);
    const service = visitTitle(next.services.map((x) => ({ title: x.service.title })), next.primaryService?.title ?? "приём");
    text = text
      .replace(/\{\{date\}\}/g, date)
      .replace(/\{\{time\}\}/g, time)
      .replace(/\{\{doctor\}\}/g, next.staff?.name ?? "врач")
      .replace(/\{\{service\}\}/g, service);
    facts = `${d} ${time} ${service}`;
  }
  // Незнакомые заготовки модели в письмо не уходят.
  text = text.replace(/\{\{[^}]*\}\}/g, "").replace(/[ \t]{2,}/g, " ").trim();
  return { text, missing, facts };
}

/** Числа письма, которых нет в поручении и в подставленных фактах. */
function numbersNotIn(text: string, source: string): string[] {
  const have = new Set(source.match(/\d+/g) ?? []);
  return [...new Set((text.match(/\d+/g) ?? []).filter((n) => !have.has(n)))];
}

/** «ближайшая запись 15 октября в 08:00, Остеопатия» — или «записи впереди нет». */
async function nearestBookingLabel(companyId: string, patientId: string, now: Date): Promise<string> {
  const next = await prisma.appointment.findFirst({
    where: { companyId, patientId, deletedAt: null, startAt: { gte: now }, status: { notIn: ["CANCELLED", "NO_SHOW"] } },
    orderBy: { startAt: "asc" },
    select: { startAt: true, primaryService: { select: { title: true } }, services: { select: { service: { select: { title: true } } } } },
  });
  if (!next) return "записи впереди нет";
  const [, m, d] = clinicDateKey(next.startAt).split("-").map(Number);
  const title = visitTitle(next.services.map((x) => ({ title: x.service.title })), next.primaryService?.title ?? "приём");
  return `ближайшая запись ${d} ${MONTHS_GEN[m - 1]} в ${TIME.format(next.startAt)}, ${title}`;
}
