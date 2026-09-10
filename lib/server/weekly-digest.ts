import { prisma } from "@/lib/db";
import { weeklyBuckets, weekStartMs } from "@/lib/server/weekly-series";
import { countInquiriesFromDb } from "@/lib/metrics/inquiries";
import { getCallbackQueue } from "@/lib/server/callback-queue";
import {
  agentAutonomy,
  type AutonomyDialog,
} from "@/lib/metrics/agent";
import {
  firstResponses,
  isWorkingTime,
  type DialogMessage,
  type WorkingHours,
} from "@/lib/metrics/response-time";
import { median } from "@/lib/metrics/deviation";
import { buildDigest, capitalizeFirst, type Digest, type MetricSeries } from "@/lib/metrics/digest";
import { weekLabel as weekKeyLabel, weekKeyOf } from "@/lib/metrics/types";

/**
 * Еженедельная сводка владельцу.
 *
 * ИИ-аналитик отвечает на вопросы; сводка сама находит, о чём стоит спросить.
 * Три-пять наблюдений с числами и ссылками — не дашборд и не двадцать метрик.
 *
 * Все числа считает НАШ код, теми же функциями, что и отчёты (§8). Модель
 * только связывает готовые наблюдения в текст и не имеет права принести в него
 * ни одного числа, которого мы ей не давали: аналитик уже однажды сложил
 * дневные суммы и назвал 300 100 ₽ там, где было 396 080 ₽. Проверка стоит
 * ниже (`numbersAreOurs`), и при расхождении уходит наш собственный текст.
 *
 * Переписка и персональные данные в модель не уходят: только агрегаты клиники
 * (§7).
 */

/** Сколько недель истории берём: восемь для сравнения плюс разбираемая. */
export const HISTORY_WEEKS = 8;
const TOTAL_WEEKS = HISTORY_WEEKS + 1;

const BASE_URL = (process.env.ROUTER_AI_BASE_URL || "https://routerai.ru/api/v1").replace(/\/+$/, "");
const MODEL = process.env.ROUTER_AI_MODEL || "anthropic/claude-sonnet-4.5";
const TIMEOUT_MS = Number(process.env.ROUTER_AI_TIMEOUT_MS ?? 20_000);

export interface DigestMetrics {
  [key: string]: number;
}

export interface WeeklyDigestResult {
  weekKey: string;
  created: boolean;
  observations: number;
  /** Почему не сформировали, если не сформировали. */
  skipped: string | null;
}

/**
 * Собрать ряды и наблюдения за последнюю ПОЛНУЮ неделю.
 *
 * Никаких обращений к модели: этим же кодом пользуется скрипт разбора, чтобы
 * можно было посмотреть, что сводка увидит, ничего не потратив.
 */
export async function collectDigest(
  companyId: string,
  now: Date = new Date(),
): Promise<{ weekKey: string; label: string; digest: Digest; metrics: DigestMetrics }> {
  const buckets = await weeklyBuckets(companyId, TOTAL_WEEKS, now);
  const currentWeekStart = weekStartMs(now);
  const weekStart = new Date(currentWeekStart - 7 * 24 * 3600 * 1000);
  const weekEnd = new Date(currentWeekStart);
  const since = new Date(buckets[0].key);
  const weekKey = weekKeyOf(new Date(weekStart.getTime() + 12 * 3600 * 1000));

  const inWeek = (at: Date) => weekStartMs(at);
  /** Разложить ряд по неделям в том же порядке, что и `buckets`. */
  const spread = (counts: Map<number, number>): number[] =>
    buckets.map((b) => counts.get(b.key) ?? 0);

  const [appts, messages, schedule, escalations, queueSize] = await Promise.all([
    /**
     * Все визиты окна, включая неявки и неотмеченные: §8 требует показывать
     * разобранность рядом с неявками ВСЕГДА, иначе «неявок 0%» означает либо
     * «неявок нет», либо «никто ничего не отмечает».
     */
    prisma.appointment.findMany({
      where: { companyId, deletedAt: null, startAt: { gte: since, lt: weekEnd } },
      select: { startAt: true, status: true },
    }),
    /**
     * Сообщения окна плюс сутки после его конца: правило «закрыл сам» смотрит
     * на сутки ПОСЛЕ ответа агента, и обрезать их по границе недели значило бы
     * записать в успех то, что человек разгребал на следующий день.
     */
    prisma.message.findMany({
      where: {
        companyId,
        deletedAt: null,
        isDraft: false,
        createdAt: { gte: since, lt: new Date(weekEnd.getTime() + 24 * 3600 * 1000) },
        conversation: { isPractice: false },
      },
      select: {
        conversationId: true,
        direction: true,
        authorType: true,
        authorId: true,
        channel: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.clinicSchedule.findMany({
      where: { companyId },
      select: { weekday: true, startMinute: true, endMinute: true },
    }),
    prisma.escalation.findMany({
      where: { companyId, createdAt: { gte: since, lt: new Date(weekEnd.getTime() + 24 * 3600 * 1000) } },
      select: { conversationId: true, createdAt: true },
    }),
    /**
     * «Кому позвонить» — запас, а не поток: сколько человек ждёт звонка
     * СЕЙЧАС. Задним числом такой список не восстановить, поэтому история
     * берётся из прошлых сводок, а первые восемь недель сравнения не будет.
     * Считает та же функция, что рисует сам экран (§8).
     */
    getCallbackQueue(companyId)
      .then((q) => q.rows.length)
      .catch(() => 0),
  ]);

  // ── визиты: неявки и разобранность
  const noShowByWeek = new Map<number, number>();
  const settledByWeek = new Map<number, number>();
  const unmarkedByWeek = new Map<number, number>();
  const MARK_GRACE_MS = 24 * 3600 * 1000;
  for (const a of appts) {
    const key = inWeek(a.startAt);
    if (a.status === "NO_SHOW" || a.status === "ARRIVED") {
      settledByWeek.set(key, (settledByWeek.get(key) ?? 0) + 1);
      if (a.status === "NO_SHOW") noShowByWeek.set(key, (noShowByWeek.get(key) ?? 0) + 1);
    } else if (
      (a.status === "CREATED" || a.status === "CONFIRMED") &&
      a.startAt.getTime() + MARK_GRACE_MS < now.getTime()
    ) {
      unmarkedByWeek.set(key, (unmarkedByWeek.get(key) ?? 0) + 1);
    }
  }
  const noShowRate = buckets.map((b) => {
    const settled = settledByWeek.get(b.key) ?? 0;
    return settled === 0 ? 0 : ((noShowByWeek.get(b.key) ?? 0) / settled) * 100;
  });

  // ── скорость первого ответа: медиана по неделе, в рабочие часы
  const hours = schedule as WorkingHours[];
  const dialogMessages: DialogMessage[] = messages.map((m) => ({
    conversationId: m.conversationId,
    direction: m.direction,
    authorType: m.authorType,
    channel: m.channel,
    createdAt: m.createdAt,
    staffUserId: m.authorType === "STAFF" ? m.authorId : null,
  }));
  const responseByWeek = new Map<number, number[]>();
  for (const b of buckets) {
    const slice = dialogMessages.filter(
      (m) => m.createdAt >= new Date(b.key) && m.createdAt < new Date(b.key + 7 * 24 * 3600 * 1000),
    );
    const { responses } = firstResponses(slice, hours);
    /**
     * Ночное ожидание в сравнение не берём: агент работает круглосуточно,
     * человек нет, и ночь испортила бы сравнение недель между собой так же,
     * как она портит пользу агента.
     */
    const working = responses.filter((r) => r.duringWorkingHours).map((r) => r.ms);
    responseByWeek.set(b.key, working);
  }
  const firstResponseMin = buckets.map((b) => {
    const values = responseByWeek.get(b.key) ?? [];
    return values.length === 0 ? 0 : median(values) / 60_000;
  });

  // ── автономность агента и эскалации
  const escByDialog = new Map<string, Date[]>();
  for (const e of escalations) {
    escByDialog.set(e.conversationId, [...(escByDialog.get(e.conversationId) ?? []), e.createdAt]);
  }
  const autonomyByWeek = new Map<number, number>();
  for (const b of buckets) {
    const from = new Date(b.key);
    const to = new Date(b.key + 7 * 24 * 3600 * 1000);
    /** Последний ответ агента в этой неделе по каждому диалогу. */
    const lastAgent = new Map<string, Date>();
    for (const m of messages) {
      if (m.direction === "OUT" && m.authorType === "BOT" && m.createdAt >= from && m.createdAt < to) {
        lastAgent.set(m.conversationId, m.createdAt);
      }
    }
    const dialogs: AutonomyDialog[] = [...lastAgent].map(([conversationId, agentRepliedAt]) => {
      const after = messages.filter(
        (m) => m.conversationId === conversationId && m.createdAt > agentRepliedAt,
      );
      return {
        conversationId,
        agentRepliedAt,
        staffRepliedAt: after.find((m) => m.authorType === "STAFF")?.createdAt ?? null,
        patientRepliedAt: after.find((m) => m.authorType === "PATIENT")?.createdAt ?? null,
        escalatedAt:
          (escByDialog.get(conversationId) ?? []).find((at) => at > agentRepliedAt) ?? null,
      };
    });
    const rate = agentAutonomy(dialogs).rate;
    autonomyByWeek.set(b.key, rate === null ? 0 : rate * 100);
  }
  const escalationsByWeek = new Map<number, number>();
  for (const e of escalations) {
    if (e.createdAt >= weekEnd) continue;
    const key = inWeek(e.createdAt);
    escalationsByWeek.set(key, (escalationsByWeek.get(key) ?? 0) + 1);
  }

  // ── обращения: та же функция, что и в отчётах (§8)
  const inquiries: number[] = [];
  for (const b of buckets) {
    const totals = await countInquiriesFromDb(
      companyId,
      new Date(b.key),
      new Date(b.key + 7 * 24 * 3600 * 1000),
    );
    inquiries.push(totals.total);
  }

  // ── история «кому позвонить» берётся из прошлых сводок: это запас, не поток
  const past = await prisma.weeklyDigest.findMany({
    where: { companyId, weekStart: { lt: weekStart } },
    orderBy: { weekStart: "desc" },
    take: HISTORY_WEEKS,
    select: { metrics: true },
  });
  const queueHistory = past
    .map((p) => (p.metrics as DigestMetrics | null)?.queue)
    .filter((v): v is number => typeof v === "number")
    .reverse();

  const last = <T,>(arr: T[]): T => arr[arr.length - 1];
  const head = <T,>(arr: T[]): T[] => arr.slice(0, -1);

  const revenue = buckets.map((b) => b.revenue);
  const arrived = buckets.map((b) => b.appts);
  const newPatients = buckets.map((b) => b.newPatients);
  const unmarked = spread(unmarkedByWeek);
  const autonomy = buckets.map((b) => autonomyByWeek.get(b.key) ?? 0);
  const escalationCounts = spread(escalationsByWeek);

  const series: MetricSeries[] = [
    {
      key: "revenue",
      title: "Выручка недели",
      history: head(revenue),
      current: last(revenue),
      unit: "money",
      // Разница меньше десяти тысяч на недельной выручке — не тема разговора.
      minAbsolute: 10_000,
      href: "/reports",
      worseWhen: "down",
    },
    {
      key: "arrived",
      title: "Состоявшиеся приёмы",
      history: head(arrived),
      current: last(arrived),
      unit: "count",
      minAbsolute: 3,
      href: "/reports",
      worseWhen: "down",
    },
    {
      key: "newPatients",
      title: "Новые пациенты",
      history: head(newPatients),
      current: last(newPatients),
      unit: "count",
      minAbsolute: 2,
      href: "/reports",
      worseWhen: "down",
    },
    {
      key: "inquiries",
      title: "Обращения",
      history: head(inquiries),
      current: last(inquiries),
      unit: "count",
      minAbsolute: 3,
      href: "/inbox",
      worseWhen: "down",
    },
    {
      key: "noShow",
      title: "Доля неявок",
      history: head(noShowRate),
      current: last(noShowRate),
      unit: "percent",
      minAbsolute: 3,
      href: "/reports",
      worseWhen: "up",
      note: `Неразобранных визитов за ту же неделю: ${last(unmarked)}. Без этого числа доля неявок читается неверно.`,
    },
    {
      key: "unmarked",
      title: "Визиты без отметки о посещении",
      history: head(unmarked),
      current: last(unmarked),
      unit: "count",
      minAbsolute: 3,
      href: "/reports",
      worseWhen: "up",
    },
    {
      key: "firstResponse",
      title: "Первый ответ пациенту (медиана, рабочие часы)",
      history: head(firstResponseMin),
      current: last(firstResponseMin),
      unit: "minutes",
      minAbsolute: 5,
      href: "/inbox",
      worseWhen: "up",
    },
    {
      key: "agentClosed",
      title: "Разговоров ассистент закрыл сам",
      history: head(autonomy),
      current: last(autonomy),
      unit: "percent",
      minAbsolute: 5,
      href: "/owner",
      worseWhen: "down",
    },
    {
      key: "escalations",
      title: "Звали человека",
      history: head(escalationCounts),
      current: last(escalationCounts),
      unit: "count",
      minAbsolute: 3,
      href: "/settings/assistant",
      worseWhen: "up",
    },
    {
      key: "queue",
      title: "В списке «кому позвонить»",
      history: queueHistory,
      current: queueSize,
      unit: "count",
      minAbsolute: 3,
      href: "/queue",
      worseWhen: "up",
    },
  ];

  const digest = buildDigest({
    series,
    appointments: last(arrived),
    appointmentsHistory: head(arrived),
  });

  const metrics: DigestMetrics = {
    revenue: last(revenue),
    arrived: last(arrived),
    newPatients: last(newPatients),
    inquiries: last(inquiries),
    noShow: last(noShowRate),
    unmarked: last(unmarked),
    firstResponse: last(firstResponseMin),
    agentClosed: last(autonomy),
    escalations: last(escalationCounts),
    queue: queueSize,
  };

  return { weekKey, label: weekKeyLabel(weekKey), digest, metrics };
}

/**
 * Собственный текст сводки — из наблюдений, без модели.
 *
 * Он нужен не только на случай недоступной модели: это эталон, с которым
 * сверяется её текст. Числа здесь ровно те, что посчитал наш код.
 */
export function plainText(label: string, digest: Digest): string {
  const parts: string[] = [`Неделя ${label}.`];
  if (digest.note) parts.push(digest.note);
  for (const o of digest.observations) {
    const hypothesis = o.hypothesis ? ` ${capitalizeFirst(o.hypothesis)}.` : "";
    const note = o.note ? ` ${o.note}` : "";
    parts.push(`${o.title}: ${o.text}.${hypothesis}${note}`);
  }
  return parts.join("\n\n");
}

/**
 * Все ли числа в тексте — наши.
 *
 * Модель переписывает готовые наблюдения; появившееся у неё число, которого мы
 * не давали, означает, что она посчитала сама, а этого она делать не умеет.
 * Сравниваем по цифрам, отбросив разделители разрядов и знаки: «200 000 ₽» и
 * «200000₽» — одно и то же число.
 */
export function numbersAreOurs(text: string, sources: string[]): boolean {
  const digitsOf = (s: string) =>
    (s.match(/\d[\d  \s.,]*/g) ?? [])
      .map((n) => n.replace(/[^\d]/g, ""))
      .filter((n) => n.length > 0);
  const allowed = new Set(sources.flatMap(digitsOf));
  return digitsOf(text).every((n) => allowed.has(n));
}

/**
 * Попросить модель связать наблюдения в текст.
 *
 * Возвращает `null`, если модель недоступна ИЛИ принесла своё число: и то, и
 * другое означает, что своим текстом пользоваться нельзя.
 */
async function phrase(label: string, digest: Digest): Promise<string | null> {
  const key = process.env.ROUTER_AI;
  if (!key) return null;

  const facts = [
    `Неделя: ${label}.`,
    ...(digest.note ? [digest.note] : []),
    ...digest.observations.map(
      (o) =>
        `${o.title}: ${o.text}.` +
        (o.hypothesis ? ` Возможная причина: ${o.hypothesis}.` : "") +
        (o.note ? ` ${o.note}` : ""),
    ),
  ];

  const rules = [
    "Ты пишешь короткую еженедельную сводку владельцу небольшой клиники.",
    "Тебе дают готовые наблюдения с числами. Твоя работа — связать их в три коротких абзаца на русском.",
    "НИ ОДНОГО числа, которого нет в наблюдениях. Не складывай, не вычитай, не считай проценты.",
    "Причину подавай как предположение: «возможно, связано с тем, что», а не «потому что».",
    "Без вступлений, без обращений, без выводов о том, что делать. Только то, что дано.",
    "Не пугай и не хвали: это рабочая записка, а не отчёт об успехах.",
  ].join(" ");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_tokens: 600,
        messages: [
          { role: "system", content: rules },
          { role: "user", content: facts.join("\n") },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = (data.choices?.[0]?.message?.content ?? "").trim();
    if (text.length < 20) return null;
    /**
     * Чужое число — брак целиком, а не повод поправить одну строку: если
     * модель посчитала что-то сама, доверять нельзя и остальному тексту.
     */
    return numbersAreOurs(text, facts) ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Сформировать сводку за последнюю полную неделю и сохранить её.
 *
 * Повторный запуск ничего не задваивает: неделя уникальна на клинику. Уже
 * сохранённая сводка не переписывается — владелец мог её прочитать, и менять
 * прочитанное задним числом нельзя.
 */
export async function makeWeeklyDigest(
  companyId: string,
  now: Date = new Date(),
): Promise<WeeklyDigestResult> {
  const { weekKey, label, digest, metrics } = await collectDigest(companyId, now);
  const currentWeekStart = weekStartMs(now);
  const weekStart = new Date(currentWeekStart - 7 * 24 * 3600 * 1000);

  const existing = await prisma.weeklyDigest.findUnique({
    where: { companyId_weekStart: { companyId, weekStart } },
    select: { id: true },
  });
  if (existing) {
    return { weekKey, created: false, observations: digest.observations.length, skipped: "уже есть" };
  }

  const written = await phrase(label, digest);
  await prisma.weeklyDigest.create({
    data: {
      companyId,
      weekStart,
      label,
      text: written ?? plainText(label, digest),
      byModel: written !== null,
      hasBaseline: digest.hasBaseline,
      observations: digest.observations as unknown as object,
      metrics: metrics as unknown as object,
    },
  });

  return { weekKey, created: true, observations: digest.observations.length, skipped: null };
}

export { isWorkingTime };
