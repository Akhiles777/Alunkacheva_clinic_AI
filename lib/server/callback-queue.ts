import { prisma } from "@/lib/db";
import { freeGaps } from "@/lib/metrics/occupancy";
import { clinicMinuteOfDay } from "@/lib/clinic-time";
import { clinicDateKey, clinicDayFor } from "@/lib/server/clinic-day";
import { stalledFallbackDays } from "@/lib/server/stalled-threshold";
import {
  buildQueue,
  type CandidateKind,
  type QueueCourse,
  type QueueInput,
  type QueueRow,
} from "@/lib/metrics/callback-queue";

/**
 * Очередь «Кому позвонить» — из базы.
 *
 * Чтение и склейка; правила отбора и сортировки живут в чистых функциях
 * `lib/metrics/callback-queue.ts`. Здесь три вопроса к базе: кто ходил, у кого
 * есть будущая запись и в каком состоянии переписка.
 */

/** Насколько глубоко смотрим историю. Дальше это уже не «спящий», а «был когда-то». */
const HISTORY_DAYS = 400;

export interface QueueContact {
  /** Канал последнего диалога: в нём и писать. */
  channel: "whatsapp" | "instagram" | "telegram" | null;
  /**
   * Состояние 24-часового окна ДО попытки отправки.
   *
   * Показывается заранее не для красоты: в закрытое окно свободный текст
   * просто не уйдёт, и администратор узнавал об этом уже после нажатия — по
   * сообщению, повисшему в «отправляется». Открыто окно или нет, видно до
   * того, как человек начал писать.
   */
  windowOpen: boolean;
  /** Сколько часов окна осталось. null — окна нет или оно закрыто. */
  windowHoursLeft: number | null;
  /**
   * Сколько дней назад пациент писал сам. null — не писал ни разу.
   *
   * Для WhatsApp это единственное честное число: жёсткого окна там нет, а
   * давность разговора всё равно решает, как начинать.
   */
  lastInboundDays: number | null;
  /** Переписки нет вовсе: писать первым некуда, остаётся телефон. */
  hasDialog: boolean;
  phone: string | null;
}

export interface QueueRowView extends QueueRow {
  contact: QueueContact;
}

export interface QueueOutcome {
  /**
   * Скольким ЛЮДЯМ написали из списка за срок.
   *
   * По людям, а не по нажатиям: два сообщения одному пациенту — это один
   * человек, и доля «записались из написанных» иначе занижалась бы тем
   * сильнее, чем настойчивее работает администратор.
   */
  outreaches: number;
  /** Скольких из них записали в течение 7 дней. */
  booked: number;
  /** Сколько из записавшихся дошло. */
  arrived: number;
  /** Деньги состоявшихся визитов. Планы будущих сюда не идут (§8). */
  revenue: number;
  days: number;
}

export interface CallbackQueue {
  rows: QueueRowView[];
  withoutThreshold: number;
  outcome: QueueOutcome;
}

/** Сколько дней после звонка засчитываем запись за списком. */
export const ATTRIBUTION_DAYS = 7;
/** За какой срок считаем результат раздела. */
export const OUTCOME_WINDOW_DAYS = 30;

/** 24-часовое окно свободного ответа. */
const WINDOW_MS = 24 * 3600 * 1000;

export async function getCallbackQueue(companyId: string): Promise<CallbackQueue> {
  const now = new Date();
  const since = new Date(now.getTime() - HISTORY_DAYS * 24 * 3600 * 1000);

  /**
   * Запасной порог клиники — для услуг, где свой не задан. Настройка, а не
   * константа: через сколько дней человек считается потерянным, решает
   * клиника. Пусто — по таким услугам не звать вовсе.
   */
  const fallback = await stalledFallbackDays(companyId);
  const thresholdOf = (own: number | null | undefined) =>
    own != null
      ? { thresholdDays: own, thresholdFrom: "SERVICE" as const }
      : { thresholdDays: fallback, thresholdFrom: "CLINIC" as const };

  const [appts, courses, conversations, outcome] = await Promise.all([
    /**
     * Визиты за историю и все будущие: нижняя граница есть, верхней нет.
     * Будущие нужны целиком — именно они убирают человека из очереди, и
     * запись на ноябрь снимает вопрос так же, как запись на завтра.
     */
    prisma.appointment.findMany({
      where: {
        companyId,
        deletedAt: null,
        startAt: { gte: since },
      },
      select: {
        patientId: true,
        startAt: true,
        status: true,
        primaryServiceId: true,
        patient: { select: { name: true, deletedAt: true } },
        primaryService: {
          select: { title: true, price: true, stalledAfterDays: true },
        },
      },
      orderBy: { startAt: "asc" },
    }),
    prisma.course.findMany({
      where: { companyId, status: "ACTIVE" },
      select: {
        id: true,
        patientId: true,
        sessionsTotal: true,
        sessionsUsed: true,
        sessionsBooked: true,
        pricePerSession: true,
        service: { select: { title: true, stalledAfterDays: true } },
        appointments: {
          where: { deletedAt: null, status: "ARRIVED" },
          select: { startAt: true },
          orderBy: { startAt: "desc" },
          take: 1,
        },
      },
    }),
    /**
     * Диалоги пациентов: канал и когда пациент писал в последний раз. По
     * этому времени и считается окно свободного ответа.
     */
    prisma.conversation.findMany({
      where: {
        companyId,
        deletedAt: null,
        patientId: { not: null },
        /**
         * Диалоги с адресом `local-…` остались от прежнего поведения кнопки
         * «Написать»: она заводила переписку, которой нет ни в WhatsApp, ни в
         * Instagram. Отправить туда нельзя, и показывать их как канал связи
         * значит обещать несуществующее.
         */
        NOT: { externalUserId: { startsWith: "local-" } },
      },
      select: {
        patientId: true,
        channel: true,
        lastPatientMessageAt: true,
        lastMessageAt: true,
      },
      orderBy: { lastMessageAt: "desc" },
    }),
    queueOutcome(companyId),
  ]);

  /** Будущая запись — единственное, что снимает человека с очереди. */
  const future = new Set(
    appts
      .filter((a) => a.startAt > now && a.status !== "CANCELLED")
      .map((a) => a.patientId),
  );

  const byPatient = new Map<string, QueueInput>();
  const ensure = (patientId: string, name: string): QueueInput => {
    const found = byPatient.get(patientId);
    if (found) return found;
    const created: QueueInput = {
      patientId,
      patientName: name,
      hasFutureBooking: future.has(patientId),
      lastVisitAt: null,
      lastVisitTitle: null,
      thresholdDays: null,
      thresholdFrom: "SERVICE",
      servicePrice: null,
      noShowAt: null,
      noShowTitle: null,
      noShowThresholdDays: null,
      noShowThresholdFrom: "SERVICE",
      noShowPrice: null,
      courses: [],
    };
    byPatient.set(patientId, created);
    return created;
  };

  for (const a of appts) {
    if (a.patient?.deletedAt) continue;
    const row = ensure(a.patientId, a.patient?.name ?? "без имени");

    if (a.status === "ARRIVED" && (!row.lastVisitAt || a.startAt > row.lastVisitAt)) {
      row.lastVisitAt = a.startAt;
      row.lastVisitTitle = a.primaryService?.title ?? null;
      const t = thresholdOf(a.primaryService?.stalledAfterDays);
      row.thresholdDays = t.thresholdDays;
      row.thresholdFrom = t.thresholdFrom;
      /**
       * Цена по прайсу — это план, а не выручка (§8). Он нужен только чтобы
       * понимать порядок величин при сортировке, и в строке подписан как
       * потенциал, а не как деньги клиники.
       */
      row.servicePrice = a.primaryService?.price != null ? Number(a.primaryService.price) : null;
    }
    if (a.status === "NO_SHOW" && (!row.noShowAt || a.startAt > row.noShowAt)) {
      row.noShowAt = a.startAt;
      row.noShowTitle = a.primaryService?.title ?? null;
      /**
       * Порог и цена — у пропущенной услуги, а не у последнего визита.
       * Человек не пришёл на остеопатию за 8 000, и в строке должна стоять
       * она, а не забор анализов, на который он ходил в прошлом году.
       */
      const t = thresholdOf(a.primaryService?.stalledAfterDays);
      row.noShowThresholdDays = t.thresholdDays;
      row.noShowThresholdFrom = t.thresholdFrom;
      row.noShowPrice = a.primaryService?.price != null ? Number(a.primaryService.price) : null;
    }
  }

  for (const c of courses) {
    const row = byPatient.get(c.patientId);
    // Курс есть, а визитов в истории нет — человек в очередь не идёт: звать
    // его не по чему, кроме самого курса, а он ещё не начинался.
    if (!row) continue;
    const course: QueueCourse = {
      courseId: c.id,
      title: c.service.title,
      total: c.sessionsTotal,
      used: c.sessionsUsed,
      booked: c.sessionsBooked,
      pricePerSession: Number(c.pricePerSession),
      lastSessionAt: c.appointments[0]?.startAt ?? null,
      ...thresholdOf(c.service.stalledAfterDays),
    };
    row.courses.push(course);
  }

  const report = buildQueue([...byPatient.values()], now);

  /** Как связаться: канал последнего диалога и состояние окна. */
  const contacts = new Map<string, QueueContact>();
  for (const c of conversations) {
    if (!c.patientId || contacts.has(c.patientId)) continue;
    const lastIn = c.lastPatientMessageAt;
    const leftMs = lastIn ? lastIn.getTime() + WINDOW_MS - now.getTime() : -1;
    contacts.set(c.patientId, {
      channel: c.channel.toLowerCase() as QueueContact["channel"],
      windowOpen: leftMs > 0,
      windowHoursLeft: leftMs > 0 ? Math.floor(leftMs / 3600000) : null,
      lastInboundDays: lastIn
        ? Math.floor((now.getTime() - lastIn.getTime()) / (24 * 3600 * 1000))
        : null,
      hasDialog: true,
      phone: null,
    });
  }

  const phones = await prisma.patientPhone.findMany({
    where: {
      companyId,
      patientId: { in: report.rows.map((r) => r.patientId) },
      isPrimary: true,
    },
    select: { patientId: true, phone: true },
  });
  const phoneOf = new Map(phones.map((p) => [p.patientId, p.phone]));

  return {
    rows: report.rows.map((r) => ({
      ...r,
      contact: contacts.get(r.patientId) ?? {
        channel: null,
        windowOpen: false,
        windowHoursLeft: null,
        lastInboundDays: null,
        hasDialog: false,
        phone: phoneOf.get(r.patientId) ?? null,
      },
    })),
    withoutThreshold: report.withoutThreshold,
    outcome,
  };
}

/**
 * Что дал список.
 *
 * Считаем только по тем, кому из списка ДЕЙСТВИТЕЛЬНО написали: запись
 * человека, которому никто не звонил, — не заслуга очереди. Иначе раздел
 * приписывал бы себе весь поток клиники и всегда выглядел бы успешным.
 *
 * Деньги — только состоявшихся визитов. Цена будущей записи деньгами не
 * считается (§8): это план из прайса, который обнулится при закрытии.
 */
export async function queueOutcome(
  companyId: string,
  days: number = OUTCOME_WINDOW_DAYS,
): Promise<QueueOutcome> {
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 3600 * 1000);

  const outreaches = await prisma.callbackOutreach.findMany({
    where: { companyId, createdAt: { gte: from } },
    select: { patientId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  if (outreaches.length === 0) {
    return { outreaches: 0, booked: 0, arrived: 0, revenue: 0, days };
  }

  const created = await prisma.appointment.findMany({
    where: {
      companyId,
      deletedAt: null,
      status: { not: "CANCELLED" },
      patientId: { in: [...new Set(outreaches.map((o) => o.patientId))] },
      createdAtYclients: { gte: from },
    },
    select: { patientId: true, createdAtYclients: true, status: true, revenue: true },
  });

  const windowMs = ATTRIBUTION_DAYS * 24 * 3600 * 1000;
  const bookedPatients = new Set<string>();
  let arrived = 0;
  let revenue = 0;

  for (const a of created) {
    const after = outreaches.find(
      (o) =>
        o.patientId === a.patientId &&
        a.createdAtYclients >= o.createdAt &&
        a.createdAtYclients.getTime() - o.createdAt.getTime() <= windowMs,
    );
    if (!after) continue;
    bookedPatients.add(a.patientId);
    if (a.status === "ARRIVED") {
      arrived += 1;
      revenue += Number(a.revenue);
    }
  }

  return {
    outreaches: new Set(outreaches.map((o) => o.patientId)).size,
    booked: bookedPatients.size,
    arrived,
    revenue,
    days,
  };
}

/** Отметить, что этому пациенту из списка написали. */
export async function recordOutreach(input: {
  companyId: string;
  patientId: string;
  kind: CandidateKind;
  basis: string;
  money: number | null;
  staffUserId: string | null;
}): Promise<void> {
  await prisma.callbackOutreach.create({
    data: {
      companyId: input.companyId,
      patientId: input.patientId,
      kind: input.kind,
      basis: input.basis.slice(0, 500),
      money: input.money,
      staffUserId: input.staffUserId,
    },
  });
}

/**
 * Свободные окна на ближайшие дни — рядом со списком.
 *
 * Звонок без окна бесполезен: «приходите когда-нибудь» — это не запись.
 * Администратор должен видеть, что именно предложить, не уходя со страницы.
 *
 * Рабочее окно берётся из графика клиники с учётом исключений (праздник,
 * санитарный день), а не из зашитых 9:00–21:00: в закрытый день мы предлагали
 * бы окна, которых нет.
 */
export interface FreeSlotDay {
  /** YYYY-MM-DD в зоне клиники. */
  date: string;
  label: string;
  /** null — клиника закрыта; причина в `closedLabel`. */
  windows: { roomName: string; from: string; to: string; durationMin: number }[] | null;
  closedLabel: string | null;
}

/** Окно короче получаса предлагать нечего. */
const MIN_SLOT_MIN = 30;

function hhmm(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export async function freeSlotsAhead(companyId: string, days = 3): Promise<FreeSlotDay[]> {
  const now = new Date();
  const rooms = await prisma.room.findMany({
    where: { companyId, isActive: true },
    select: { id: true, name: true, sortOrder: true },
    orderBy: { sortOrder: "asc" },
  });

  const out: FreeSlotDay[] = [];
  const dayLabel = new Intl.DateTimeFormat("ru-RU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "Europe/Moscow",
  });

  for (let i = 0; i < days; i++) {
    const at = new Date(now.getTime() + i * 24 * 3600 * 1000);
    const date = clinicDateKey(at);
    const { window, label } = await clinicDayFor(companyId, at);
    if (!window) {
      out.push({ date, label: dayLabel.format(at), windows: null, closedLabel: label ?? "выходной" });
      continue;
    }

    const start = new Date(`${date}T00:00:00+03:00`);
    const end = new Date(start.getTime() + 24 * 3600 * 1000);
    const appts = await prisma.appointment.findMany({
      where: {
        companyId,
        deletedAt: null,
        status: { not: "CANCELLED" },
        startAt: { gte: start, lt: end },
      },
      select: { roomId: true, startAt: true, endAt: true },
    });

    /** Сегодня прошедшие часы не предлагаем: окно в 9:00 в полдень — не окно. */
    const floor = i === 0 ? clinicMinuteOfDay(now) : window.startMinute;

    const windows: FreeSlotDay["windows"] = [];
    for (const room of rooms) {
      const intervals = appts
        .filter((a) => a.roomId === room.id)
        .map((a) => ({
          startMinute: clinicMinuteOfDay(a.startAt),
          endMinute: clinicMinuteOfDay(a.endAt),
        }));
      for (const gap of freeGaps(intervals, window, 1)) {
        const from = Math.max(gap.startMinute, floor);
        if (gap.endMinute - from < MIN_SLOT_MIN) continue;
        windows.push({
          roomName: room.name,
          from: hhmm(from),
          to: hhmm(gap.endMinute),
          durationMin: gap.endMinute - from,
        });
      }
    }
    windows.sort((a, b) => a.from.localeCompare(b.from));
    out.push({ date, label: dayLabel.format(at), windows, closedLabel: null });
  }

  return out;
}
