import { prisma } from "@/lib/db";
import { clinicMinuteOfDay, startOfClinicDay } from "@/lib/clinic-time";
import { getCallbackQueue } from "@/lib/server/callback-queue";
import {
  noShowVerdict,
  predictable,
  type NoShowFacts,
  type NoShowVerdict,
  type NoShowWeights,
} from "@/lib/metrics/no-show";

/**
 * Прогноз неявки — сбор признаков из базы.
 *
 * Считается на момент запроса и как поле не хранится: признаки меняются
 * (пациент ответил, запись перенесли), а хранимый прогноз устаревает молча.
 * В таблицу ложится только СЛУЧИВШЕЕСЯ — что мы предсказали и чем кончилось;
 * без этого через месяц никто не скажет, работает ли функция.
 *
 * Веса живут в настройках клиники, а не в коде: их подбирают по её же
 * истории (`scripts/noshow-weights.ts`). Пока веса не утверждены, прогноз не
 * показывается вовсе — выдумывать числа в медицинской клинике нельзя.
 */

export const WEIGHTS_KEY = "noShowWeights";

/** Слот считаем по дню недели и часу — так его и планирует администратор. */
const SLOT_WINDOW_DAYS = 180;

export async function getWeights(companyId: string): Promise<NoShowWeights | null> {
  const row = await prisma.setting.findUnique({
    where: { companyId_key: { companyId, key: WEIGHTS_KEY } },
  });
  const v = row?.value as Partial<NoShowWeights> | null;
  if (!v || typeof v.threshold !== "number") return null;
  return {
    history: Number(v.history ?? 0),
    horizon: Number(v.horizon ?? 0),
    firstVisit: Number(v.firstVisit ?? 0),
    unconfirmed: Number(v.unconfirmed ?? 0),
    slot: Number(v.slot ?? 0),
    courseOverdue: Number(v.courseOverdue ?? 0),
    moved: Number(v.moved ?? 0),
    threshold: Number(v.threshold),
    approvedAt: typeof v.approvedAt === "string" ? v.approvedAt : null,
  };
}

export async function saveWeights(companyId: string, weights: NoShowWeights): Promise<void> {
  await prisma.setting.upsert({
    where: { companyId_key: { companyId, key: WEIGHTS_KEY } },
    update: { value: { ...weights, approvedAt: new Date().toISOString() } },
    create: {
      companyId,
      key: WEIGHTS_KEY,
      value: { ...weights, approvedAt: new Date().toISOString() },
    },
  });
}

export interface PredictedAppointment {
  appointmentId: string;
  patientId: string;
  patientName: string;
  startAt: Date;
  title: string;
  staffName: string | null;
  verdict: NoShowVerdict;
  /** Есть ли куда писать: без канала связи в «стоит подтвердить» не берём. */
  reachable: boolean;
}

/**
 * Доля неявок клиники по слотам за полгода.
 *
 * Одним запросом на всю клинику: спрашивать по каждой записи — это сотни
 * запросов на экран, а на сервере рядом второй проект (правило памяти).
 */
async function slotRates(companyId: string): Promise<Map<string, { rate: number; total: number }>> {
  const from = new Date(Date.now() - SLOT_WINDOW_DAYS * 24 * 3600 * 1000);
  const rows = await prisma.appointment.findMany({
    where: {
      companyId,
      deletedAt: null,
      status: { in: ["ARRIVED", "NO_SHOW"] },
      startAt: { gte: from },
    },
    select: { startAt: true, status: true },
  });
  const acc = new Map<string, { missed: number; total: number }>();
  for (const r of rows) {
    const key = slotKey(r.startAt);
    const cur = acc.get(key) ?? { missed: 0, total: 0 };
    cur.total += 1;
    if (r.status === "NO_SHOW") cur.missed += 1;
    acc.set(key, cur);
  }
  const out = new Map<string, { rate: number; total: number }>();
  for (const [key, v] of acc) out.set(key, { rate: v.missed / v.total, total: v.total });
  return out;
}

function slotKey(at: Date): string {
  const hour = Math.floor(clinicMinuteOfDay(at) / 60);
  // День недели в зоне клиники: по UTC вечер пятницы становится субботой.
  const weekday = new Date(at.getTime() + 3 * 3600 * 1000).getUTCDay();
  return `${weekday}-${hour}`;
}

/**
 * Прогноз по записям в окне [from, to).
 *
 * Один проход: история пациентов, переписка и слоты собираются заранее и
 * раскладываются по записям, а не спрашиваются по одной.
 */
export async function predictNoShow(
  companyId: string,
  from: Date,
  to: Date,
): Promise<{ weights: NoShowWeights | null; rows: PredictedAppointment[] }> {
  const weights = await getWeights(companyId);
  if (!weights) return { weights: null, rows: [] };

  const appts = await prisma.appointment.findMany({
    where: {
      companyId,
      deletedAt: null,
      startAt: { gte: from, lt: to },
      status: { in: ["CREATED", "CONFIRMED"] },
    },
    select: {
      id: true,
      patientId: true,
      startAt: true,
      status: true,
      createdAtYclients: true,
      courseId: true,
      primaryService: { select: { title: true } },
      services: { select: { service: { select: { title: true } } } },
      staff: { select: { name: true } },
      patient: {
        select: {
          id: true,
          name: true,
          phones: { where: { isPrimary: true }, take: 1, select: { phone: true } },
        },
      },
    },
    orderBy: { startAt: "asc" },
  });
  if (appts.length === 0) return { weights, rows: [] };

  const patientIds = [...new Set(appts.map((a) => a.patientId))];

  const [history, conversations, slots, courses] = await Promise.all([
    prisma.appointment.groupBy({
      by: ["patientId", "status"],
      where: {
        companyId,
        deletedAt: null,
        patientId: { in: patientIds },
        status: { in: ["ARRIVED", "NO_SHOW"] },
      },
      _count: { _all: true },
    }),
    prisma.conversation.findMany({
      where: { companyId, deletedAt: null, patientId: { in: patientIds }, isPractice: false },
      select: {
        patientId: true,
        lastMessageAt: true,
        lastPatientMessageAt: true,
        externalUserId: true,
      },
    }),
    slotRates(companyId),
    /**
     * Кто выпал из ритма курса — берём из очереди «Кому позвонить», а не
     * считаем заново: одна и та же дата не может быть «выпал» на одном экране
     * и «идёт» на другом (§8). Пороги там из настроек клиники.
     */
    getCallbackQueue(companyId),
  ]);

  const arrived = new Map<string, number>();
  const missed = new Map<string, number>();
  for (const h of history) {
    if (!h.patientId) continue;
    const target = h.status === "NO_SHOW" ? missed : arrived;
    target.set(h.patientId, (target.get(h.patientId) ?? 0) + h._count._all);
  }

  /**
   * «Не ответил на сообщение клиники»: последнее слово в переписке за нами.
   * Переписки нет вовсе — признак неизвестен, а не ложен.
   */
  const talk = new Map<string, { unanswered: boolean; reachable: boolean }>();
  for (const c of conversations) {
    if (!c.patientId) continue;
    const cur = talk.get(c.patientId) ?? { unanswered: false, reachable: false };
    cur.reachable = true;
    if (c.lastMessageAt && (!c.lastPatientMessageAt || c.lastPatientMessageAt < c.lastMessageAt)) {
      cur.unanswered = true;
    }
    talk.set(c.patientId, cur);
  }

  const stalled = new Set(
    courses.rows.filter((r) => r.kind === "COURSE_STALLED").map((r) => r.patientId),
  );

  const now = new Date();
  const rows: PredictedAppointment[] = [];
  for (const a of appts) {
    if (!a.patient) continue;
    if (!predictable({ status: a.status, patientId: a.patientId, startAt: a.startAt }, now)) continue;

    const came = arrived.get(a.patientId) ?? 0;
    const skipped = missed.get(a.patientId) ?? 0;
    const seen = came + skipped;
    const slot = slots.get(slotKey(a.startAt));
    const chat = talk.get(a.patientId);

    /**
     * Горизонт: дней между созданием записи и приёмом. Запись, созданная
     * сегодня на сегодня, горизонта не имеет — это не признак, а ноль дней.
     */
    const horizonDays = a.createdAtYclients
      ? Math.max(
          0,
          Math.round(
            (startOfClinicDay(a.startAt).getTime() -
              startOfClinicDay(a.createdAtYclients).getTime()) /
              (24 * 3600 * 1000),
          ),
        )
      : null;

    const facts: NoShowFacts = {
      historyRate: seen > 0 ? skipped / seen : null,
      historyVisits: seen,
      horizonDays,
      firstVisit: came === 0,
      unconfirmed: chat ? chat.unanswered : null,
      slotRate: slot?.rate ?? null,
      slotVisits: slot?.total ?? 0,
      courseOverdue: a.courseId ? stalled.has(a.patientId) : null,
      /**
       * Признака «переносили» в базе нет: YCLIENTS переносит пересозданием, и
       * старая запись просто исчезает. Пока мы не умеем это различать честно,
       * признак неизвестен — выдумывать его нельзя.
       */
      moved: null,
    };

    const verdict = noShowVerdict(facts, weights);
    rows.push({
      appointmentId: a.id,
      patientId: a.patientId,
      patientName: a.patient.name ?? "Без имени",
      startAt: a.startAt,
      title:
        a.services.map((s) => s.service.title).join(" + ") ||
        a.primaryService?.title ||
        "приём",
      staffName: a.staff?.name ?? null,
      verdict,
      reachable: Boolean(chat?.reachable) || Boolean(a.patient.phones[0]?.phone),
    });
  }

  return { weights, rows };
}

/**
 * Записать прогноз в журнал — для обратной связи.
 *
 * Один прогноз на запись: пересчёт обновляет существующий, а не плодит
 * строки. Записываем только повышенные: журнал ведётся ради ответа «сработало
 * ли», и обычные записи в нём — шум… но тогда доля неявок среди НЕпомеченных
 * не считалась бы. Поэтому пишем и те, и другие, а различает их `level`.
 */
export async function rememberPredictions(
  companyId: string,
  rows: PredictedAppointment[],
): Promise<number> {
  let saved = 0;
  for (const r of rows) {
    await prisma.noShowPrediction.upsert({
      where: { appointmentId: r.appointmentId },
      update: {
        level: r.verdict.level,
        score: r.verdict.score,
        reasons: r.verdict.reasons,
        predictedAt: new Date(),
      },
      create: {
        companyId,
        appointmentId: r.appointmentId,
        level: r.verdict.level,
        score: r.verdict.score,
        factors: {},
        reasons: r.verdict.reasons,
      },
    });
    saved += 1;
  }
  return saved;
}

/**
 * Проставить исход состоявшимся визитам.
 *
 * Без этого шага журнал прогнозов остаётся без ответа на главный вопрос:
 * пришёл человек или нет. Идёт кругом выгрузки, порциями.
 */
export async function settleOutcomes(companyId: string): Promise<number> {
  const open = await prisma.noShowPrediction.findMany({
    where: { companyId, actualOutcome: null },
    take: 200,
    select: { id: true, appointmentId: true },
  });
  if (open.length === 0) return 0;

  const appts = await prisma.appointment.findMany({
    where: { id: { in: open.map((o) => o.appointmentId) } },
    select: { id: true, status: true, startAt: true },
  });
  const byId = new Map(appts.map((a) => [a.id, a]));

  let settled = 0;
  const now = new Date();
  for (const row of open) {
    const appt = byId.get(row.appointmentId);
    if (!appt) continue;
    const done =
      appt.status === "ARRIVED" || appt.status === "NO_SHOW" || appt.status === "CANCELLED";
    if (!done || appt.startAt > now) continue;
    await prisma.noShowPrediction.update({
      where: { id: row.id },
      data: { actualOutcome: appt.status, outcomeAt: now },
    });
    settled += 1;
  }
  return settled;
}

export interface NoShowQuality {
  /** Помеченных «стоит подтвердить», у которых визит уже разобран. */
  raised: number;
  raisedMissed: number;
  usual: number;
  usualMissed: number;
  /** Кому написали после прогноза — и сколько из них не пришло. */
  contacted: number;
  contactedMissed: number;
  /** С какого дня ведётся журнал: ноль без этой даты читается как «не работает». */
  since: string | null;
}

/**
 * Качество прогноза. Одно число ничего не значит: доля неявок среди
 * помеченных сравнивается с долей среди остальных, иначе непонятно, лучше ли
 * это подбрасывания монеты.
 */
export async function noShowQuality(companyId: string): Promise<NoShowQuality> {
  const rows = await prisma.noShowPrediction.findMany({
    where: { companyId, actualOutcome: { not: null } },
    select: { level: true, actualOutcome: true, wasContacted: true, predictedAt: true },
    orderBy: { predictedAt: "asc" },
  });

  const q: NoShowQuality = {
    raised: 0,
    raisedMissed: 0,
    usual: 0,
    usualMissed: 0,
    contacted: 0,
    contactedMissed: 0,
    since: rows[0]?.predictedAt.toISOString() ?? null,
  };
  for (const r of rows) {
    // Отменённый визит — не неявка: о нём договорились (§8).
    if (r.actualOutcome === "CANCELLED") continue;
    const missed = r.actualOutcome === "NO_SHOW";
    if (r.level === "raised") {
      q.raised += 1;
      if (missed) q.raisedMissed += 1;
    } else {
      q.usual += 1;
      if (missed) q.usualMissed += 1;
    }
    if (r.wasContacted) {
      q.contacted += 1;
      if (missed) q.contactedMissed += 1;
    }
  }
  return q;
}
