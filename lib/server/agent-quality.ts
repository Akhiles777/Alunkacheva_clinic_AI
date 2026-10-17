import { prisma } from "@/lib/db";
import {
  needsReview,
  parseVerdict,
  sampleRuns,
  SAMPLE_LIMIT,
  type RunForSample,
  type Sampled,
  type Verdict,
} from "@/lib/metrics/quality-sample";

/**
 * Контроль качества ответов агента.
 *
 * Дрейф ловится до того, как его заметит пациент: раз в неделю берём выборку
 * ответов и сверяем их с записями справочника, на которые агент ссылался.
 * Для медицинской клиники это почти обязательное условие — сочинённое
 * показание доходит до человека и приносится в кабинет как обещание клиники.
 *
 * Что уходит проверяющей модели: вопрос пациента, ответ агента и текст записи
 * справочника — ровно та же пара, которую агент УЖЕ отправлял, когда отвечал.
 * Ни имён, ни истории визитов, ни телефонов (§7, §6.5).
 *
 * Проверка ничего не решает сама: её вердикт подтверждает или отклоняет
 * человек. Проверяющая модель ошибается так же, как проверяемая.
 */

const BASE_URL = (process.env.ROUTER_AI_BASE_URL || "https://routerai.ru/api/v1").replace(/\/+$/, "");
/** Проверку ведёт тот же провайдер; модель можно задать отдельно. */
const MODEL =
  process.env.ROUTER_AI_QUALITY_MODEL || process.env.ROUTER_AI_MODEL || "anthropic/claude-sonnet-4.5";
/**
 * Своя граница ожидания, не общая с ботом. Проверка идёт ночью и никого не
 * держит, а двадцати секунд модели-проверяющему не хватало: первый же
 * медленный ответ считался «модель недоступна» и обрывал весь прогон
 * (демо-прогон 12 октября — три обрыва подряд на пяти ответах).
 */
const TIMEOUT_MS = Number(process.env.ROUTER_AI_QUALITY_TIMEOUT_MS ?? 60_000);

/** За какой срок берём ответы на проверку. */
const WINDOW_DAYS = 8;
/** Когда идёт проверка — теми же словами на экране, что и в расписании. */
export const QUALITY_WINDOW = "3:00–6:00";
/** Сколько проверок делаем за один ночной прогон. */
const BATCH = Number(process.env.AGENT_QUALITY_BATCH ?? 10);

export interface QualityRunResult {
  /** Сколько ответов попало в выборку. */
  sampled: number;
  /** Сколько проверено в этот раз. */
  checked: number;
  /** Сколько вердиктов требуют человека. */
  problems: number;
  /** Почему не проверяли: модель недоступна, нечего проверять. */
  skipped: string | null;
}

/** Один ответ, готовый к проверке: ровно то, что уйдёт модели. */
export interface SampleItem {
  runId: string;
  reason: string;
  at: Date;
  conversationId: string;
  question: string;
  answer: string;
  /** Тексты записей справочника, на которые ответ опирался. Пусто — опоры нет. */
  source: string;
}

export interface SamplePreview {
  items: SampleItem[];
  /**
   * Прайс и врачи — общая часть для всех ответов выборки. Уходит модели
   * отдельным блоком с пометкой для кэша провайдера: прежде она была частью
   * `source` у КАЖДОГО ответа, и весь прайс клиники оплачивался заново в
   * каждом из десяти запросов за тик.
   */
  catalogue: string;
  /** Сколько проверок уже сделано за неделю и сколько осталось сегодня. */
  spent: number;
  budget: number;
  /** Почему выборка пуста, если она пуста. */
  skipped: string | null;
}

/**
 * Собрать выборку — без единого обращения к модели.
 *
 * Отдельно от проверки намеренно: так выборку можно посмотреть глазами
 * (`scripts/agent-quality.ts`), ничего не потратив, и так же её проверяют
 * тесты отбора. Всё, что решает, ЧТО мы узнаем о качестве, живёт здесь.
 */
export async function previewSample(companyId: string): Promise<SamplePreview> {
  const empty = (skipped: string | null, spent = 0, budget = 0): SamplePreview => ({
    items: [],
    catalogue: "",
    spent,
    budget,
    skipped,
  });

  /**
   * Недельный бюджет расходуется порциями, но остаётся недельным.
   *
   * Прогон идёт каждую ночь, чтобы проверка не превращалась в один тяжёлый
   * час раз в семь дней — но за семь дней проверяется ровно выборка, а не
   * всё подряд. Считаем по факту сделанных проверок, а не по отметке
   * «прогон был»: отметка соврёт после любого сбоя посередине.
   */
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const spent = await prisma.agentQualityCheck.count({
    where: { companyId, checkedAt: { gte: weekAgo } },
  });
  if (spent >= SAMPLE_LIMIT) return empty("недельная выборка уже проверена", spent, 0);
  const budget = Math.min(BATCH, SAMPLE_LIMIT - spent);

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000);
  const runs = await prisma.agentRun.findMany({
    where: {
      companyId,
      outcome: "OK",
      messageId: { not: null },
      triggeredAt: { gte: since },
      qualityCheck: { is: null },
      conversation: { isPractice: false },
    },
    orderBy: { triggeredAt: "desc" },
    take: 200,
    select: {
      id: true,
      conversationId: true,
      messageId: true,
      triggeredAt: true,
      knowledgeEntryIds: true,
      escalationId: true,
    },
  });
  if (runs.length === 0) return empty("нечего проверять", spent, budget);

  /**
   * Что случилось вокруг ответа: переспросил ли пациент, была ли эскалация,
   * жив ли сам ответ. Одним запросом на всю выборку — по одному это сотни
   * обращений к базе на ночной прогон.
   */
  const messageIds = runs.map((r) => r.messageId!).filter(Boolean);
  const [messages, followUps] = await Promise.all([
    prisma.message.findMany({
      where: { id: { in: messageIds } },
      select: { id: true, body: true, deletedAt: true, conversationId: true, createdAt: true },
    }),
    prisma.message.findMany({
      where: {
        conversationId: { in: [...new Set(runs.map((r) => r.conversationId))] },
        direction: "IN",
        deletedAt: null,
        createdAt: { gte: since },
      },
      select: { conversationId: true, body: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const answerById = new Map(messages.map((m) => [m.id, m]));

  /** Вопрос пациента — ближайшее входящее ПЕРЕД ответом агента. */
  const questionFor = (conversationId: string, at: Date): string | null => {
    const before = followUps.filter((m) => m.conversationId === conversationId && m.createdAt < at);
    return before[before.length - 1]?.body ?? null;
  };
  /** Переспросил ли пациент в ближайшие два часа. */
  const reaskedAfter = (conversationId: string, at: Date): boolean =>
    followUps.some(
      (m) =>
        m.conversationId === conversationId &&
        m.createdAt > at &&
        m.createdAt.getTime() - at.getTime() < 2 * 3600 * 1000,
    );

  const MEDICAL = /бол|противопоказ|беременн|давлен|температур|диагноз|лечен|препарат|капельниц|грыж/i;

  const forSample: RunForSample[] = runs.map((r) => {
    const answer = r.messageId ? answerById.get(r.messageId) : undefined;
    const question = questionFor(r.conversationId, r.triggeredAt) ?? "";
    return {
      id: r.id,
      medical: MEDICAL.test(question) || MEDICAL.test(answer?.body ?? ""),
      reasked: reaskedAfter(r.conversationId, r.triggeredAt),
      escalated: r.escalationId !== null,
      knowledgeEntryIds: r.knowledgeEntryIds,
      checked: false,
      deleted: !answer || answer.deletedAt !== null,
    };
  });

  const sample: Sampled[] = sampleRuns(forSample, SAMPLE_LIMIT);
  if (sample.length === 0) return empty("нечего проверять", spent, budget);

  const entryIds = [...new Set(runs.flatMap((r) => r.knowledgeEntryIds))];
  const entries = entryIds.length
    ? await prisma.knowledgeEntry.findMany({
        where: { id: { in: entryIds } },
        select: { id: true, topic: true, answer: true },
      })
    : [];
  const entryById = new Map(entries.map((e) => [e.id, e]));
  /**
   * Прайс и врачи — тоже справка агента: он называет цены и длительность из
   * прайса, а не из записей справочника. Без них «диагностика у Ирины
   * Омаровой — 1000 ₽, 30 минут» помечалось как «в справке не указано», и экран
   * качества заполнялся ошибками, которых нет (демо-прогон 12 октября). Это
   * открытые сведения клиники, персональных данных здесь нет.
   */
  const [priceRows, staffRows] = await Promise.all([
    prisma.service.findMany({
      where: { companyId, isActive: true, price: { gt: 1 } },
      select: { title: true, price: true, durationMin: true },
      orderBy: { title: "asc" },
    }),
    prisma.staff.findMany({ where: { companyId, isActive: true, deletedAt: null }, select: { name: true, specialty: true } }),
  ]);
  const catalogue = [
    "Прайс клиники:",
    ...priceRows.map((r) => `${r.title} — ${Number(r.price)} ₽${r.durationMin > 0 ? `, ${r.durationMin} мин` : ""}`),
    "Специалисты:",
    ...staffRows.map((r) => `${r.name}${r.specialty ? ` — ${r.specialty}` : ""}`),
  ].join("\n");

  const items: SampleItem[] = [];
  for (const picked of sample) {
    const run = runs.find((r) => r.id === picked.runId);
    if (!run || !run.messageId) continue;
    const answer = answerById.get(run.messageId);
    if (!answer || answer.deletedAt) continue;
    items.push({
      runId: run.id,
      reason: picked.reason,
      at: run.triggeredAt,
      conversationId: run.conversationId,
      question: questionFor(run.conversationId, run.triggeredAt) ?? "",
      answer: answer.body,
      source: run.knowledgeEntryIds
        .map((id) => entryById.get(id))
        .filter(Boolean)
        .map((e) => `«${e!.topic}»: ${e!.answer}`)
        .join("\n"),
    });
  }

  return { items, catalogue, spent, budget, skipped: null };
}

/**
 * Собрать выборку и проверить её.
 *
 * Падение проверки не влияет на агента никак: он о ней не знает. Если модель
 * недоступна, очередь не теряется — те же ответы попадут в выборку следующей
 * ночью, потому что отбор идёт по фактам, а не по флагу «в очереди».
 */
export async function runQualityCheck(companyId: string): Promise<QualityRunResult> {
  const key = process.env.ROUTER_AI;
  if (!key) return { sampled: 0, checked: 0, problems: 0, skipped: "нет ключа модели" };

  const { items, catalogue, budget, skipped } = await previewSample(companyId);
  if (skipped) return { sampled: 0, checked: 0, problems: 0, skipped };

  let checked = 0;
  let problems = 0;
  let stopped: string | null = null;
  for (const item of items.slice(0, budget)) {
    const result = await judge({
      key,
      question: item.question,
      answer: item.answer,
      source: item.source,
      catalogue,
    });

    /**
     * Модель недоступна — прекращаем прогон целиком: следующие обращения
     * упрутся в то же самое. Очередь при этом не теряется, отбор идёт по
     * фактам, и завтра ночью те же ответы снова окажутся в выборке.
     */
    if (result.status === "unavailable") {
      stopped = "модель недоступна";
      break;
    }
    /**
     * Ответила непонятно — пропускаем ЭТОТ ответ, а не весь прогон, и не
     * записываем ничего: «OK» на неразобранном ответе спрятал бы ровно то,
     * что мы ищем.
     */
    /**
     * Неразобранная проверка записывается тоже — отметкой UNPARSED, без
     * пояснения. Пока её не записывали, ответ оставался в очереди, не тратил
     * недельный бюджет и уходил модели снова каждые полчаса, каждую ночь:
     * десять одних и тех же запросов с полным прайсом за тик, без единого
     * вердикта. На экран качества такая строка не попадает.
     */
    const verdict = result.status === "ok" ? result.verdict : UNPARSED;
    const comment = result.status === "ok" ? result.comment : "";

    /**
     * `create`, а не `upsert`: `agentRunId` уникален, и повторный прогон до
     * этой строки не доходит — проверенные ответы отсеиваются запросом. Гонка
     * двух прогонов упрётся в уникальный индекс, и это правильный исход:
     * второй вердикт по тому же ответу не нужен.
     */
    await prisma.agentQualityCheck.create({
      data: {
        companyId,
        agentRunId: item.runId,
        reason: item.reason,
        verdict,
        comment,
      },
    });
    if (result.status !== "ok") continue;
    checked += 1;
    if (needsReview(result.verdict)) problems += 1;
  }

  return { sampled: items.length, checked, problems, skipped: stopped };
}

/**
 * Спросить проверяющую модель.
 *
 * Ответ обязан начинаться с вердикта одним словом: свободный пересказ нельзя
 * ни сложить в статистику, ни показать человеку списком. Не распознали —
 * считаем проверку несостоявшейся, а не «всё хорошо».
 */
type JudgeResult =
  | { status: "ok"; verdict: Verdict; comment: string }
  /** Не ответила: сеть, таймаут, отказ провайдера. Прогон дальше не идёт. */
  | { status: "unavailable" }
  /** Ответила, но вердикта в ответе нет. Пропускаем этот ответ. */
  | { status: "unparsed" };

/** Проверка состоялась, а вердикт из ответа модели не разобран. */
export const UNPARSED = "UNPARSED";

async function judge(input: {
  key: string;
  question: string;
  answer: string;
  source: string;
  catalogue: string;
}): Promise<JudgeResult> {
  const rules = [
    "Ты проверяешь ответ справочной службы медицинской клиники.",
    "Тебе дают вопрос пациента, ответ службы и текст справки клиники, на который она опиралась.",
    "Оцени ОДНИМ словом-вердиктом и коротким пояснением на русском.",
    "OK — ответ опирается на справку и ничего к ней не добавляет.",
    "DEVIATION — ответ противоречит справке или искажает её.",
    "UNSUPPORTED_CLAIM — в ответе есть утверждение, цена, время или показание, которых в справке нет.",
    "MEDICAL_WITHOUT_SOURCE — ответ на медицинскую тему без опоры на справку.",
    "UNFINISHED — служба могла довести разговор до конца, но оборвала его или ответила не по делу.",
    "Прайс и список специалистов — тоже справка клиники: цены и длительность из прайса утверждениями без справки не считаются.",
    // «ВЕРДИКТ: пояснение» модель понимала буквально и писала само слово «ВЕРДИКТ» — такой ответ не разбирался.
    "Ответ — одна строка: первым словом сам вердикт латиницей, затем двоеточие и пояснение. Пример: «UNSUPPORTED_CLAIM: в справке нет цены 3000 ₽». Один вердикт, ничего больше.",
  ].join(" ");

  const body = [
    `Вопрос пациента: ${input.question || "(не сохранился)"}`,
    `Ответ службы: ${input.answer}`,
    input.source ? `Записи справочника, на которые опирался ответ:\n${input.source}` : "Записи справочника: (ответ дан без записей справочника)",
  ].join("\n\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${input.key}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 200,
        messages: [
          {
            role: "system",
            // Правила и прайс одинаковы для всей выборки — кэш провайдера, как у аналитика.
            content: [{ type: "text", text: `${rules}\n\n${input.catalogue}`, cache_control: { type: "ephemeral" } }],
          },
          { role: "user", content: body },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return { status: "unavailable" };
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const parsed = parseVerdict(data.choices?.[0]?.message?.content ?? "");
    return parsed ? { status: "ok", ...parsed } : { status: "unparsed" };
  } catch {
    // Модель недоступна — проверка откладывается до следующего прогона.
    return { status: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

export interface QualityProblem {
  id: string;
  verdict: string;
  comment: string;
  reason: string;
  at: string;
  question: string;
  answer: string;
  conversationId: string;
}

/** Проблемные ответы, которые ещё не смотрел человек. */
export async function qualityProblems(companyId: string, limit = 30): Promise<QualityProblem[]> {
  const rows = await prisma.agentQualityCheck.findMany({
    where: { companyId, verdict: { notIn: ["OK", UNPARSED] }, reviewedAt: null },
    orderBy: { checkedAt: "desc" },
    take: limit,
    select: {
      id: true,
      verdict: true,
      comment: true,
      reason: true,
      checkedAt: true,
      agentRun: {
        select: {
          conversationId: true,
          messageId: true,
          triggeredAt: true,
        },
      },
    },
  });
  if (rows.length === 0) return [];

  const messages = await prisma.message.findMany({
    where: { id: { in: rows.map((r) => r.agentRun.messageId!).filter(Boolean) } },
    select: { id: true, body: true },
  });
  const answerById = new Map(messages.map((m) => [m.id, m.body]));

  const incoming = await prisma.message.findMany({
    where: {
      conversationId: { in: [...new Set(rows.map((r) => r.agentRun.conversationId))] },
      direction: "IN",
      deletedAt: null,
    },
    select: { conversationId: true, body: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  return rows.map((r) => {
    const before = incoming.filter(
      (m) => m.conversationId === r.agentRun.conversationId && m.createdAt < r.agentRun.triggeredAt,
    );
    return {
      id: r.id,
      verdict: r.verdict,
      comment: r.comment,
      reason: r.reason,
      // ISO, а не готовая строка: формат выбирает экран, ему же виден часовой
      // пояс. Отданная отсюда «10 сент., 18:20» на экране разбиралась обратно
      // в дату и падала.
      at: r.checkedAt.toISOString(),
      question: before[before.length - 1]?.body ?? "(вопрос не сохранился)",
      answer: r.agentRun.messageId ? (answerById.get(r.agentRun.messageId) ?? "") : "",
      conversationId: r.agentRun.conversationId,
    };
  });
}

export interface QualitySummary {
  checked: number;
  problems: number;
  confirmed: number;
  rejected: number;
  since: string | null;
}

export async function qualitySummary(companyId: string): Promise<QualitySummary> {
  const rows = await prisma.agentQualityCheck.findMany({
    // Неразобранная проверка — не проверка: в «проверено» и «отклонения» не идёт.
    where: { companyId, verdict: { not: UNPARSED } },
    select: { verdict: true, confirmed: true, checkedAt: true },
    orderBy: { checkedAt: "asc" },
  });
  return {
    checked: rows.length,
    problems: rows.filter((r) => r.verdict !== "OK").length,
    confirmed: rows.filter((r) => r.confirmed === true).length,
    rejected: rows.filter((r) => r.confirmed === false).length,
    since: rows[0]?.checkedAt.toISOString() ?? null,
  };
}
