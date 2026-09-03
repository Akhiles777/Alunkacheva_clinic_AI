import { prisma } from "@/lib/db";
import type { AgentRunOutcome } from "@/generated/prisma/enums";

/**
 * Журнал попыток агента.
 *
 * Прежде сбои модели жили только в выводе процесса: «бот иногда молчит»
 * оставалось ощущением, а не числом, и восстановить историю отказов
 * постфактум было нельзя. Теперь на каждую попытку — строка, включая повтор
 * после таймаута.
 *
 * Запись журнала НИКОГДА не роняет ответ пациенту. Любая ошибка здесь
 * проглатывается: не работает наблюдаемость — плохо, не работает клиника —
 * недопустимо.
 *
 * Персональных данных не пишем (§7): ни тел сообщений, ни имён, ни телефонов.
 * Только идентификаторы и техническая причина.
 */

/** Сколько знаков технической причины хранить. Стектрейс здесь не нужен. */
const ERROR_LIMIT = 300;

/**
 * Очистка технической причины от эха пользовательского текста.
 *
 * Провайдер иногда возвращает в теле ошибки кусок запроса — а в запросе лежит
 * вопрос пациента. Такой текст в журнал попасть не должен. Режем всё, что
 * похоже на содержимое запроса: кавычки с длинным содержимым и явные поля
 * промпта. Остаётся то, ради чего строка и заводится: код ошибки и срок.
 */
export function sanitizeError(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw);
  if (!text.trim()) return null;

  const cleaned = text
    // Тела в кавычках длиннее двадцати знаков — это почти наверняка эхо запроса.
    .replace(/"[^"]{20,}"/g, '"…"')
    .replace(/'[^']{20,}'/g, "'…'")
    // Явные поля промпта, если провайдер вернул кусок структуры.
    .replace(/"(content|messages|prompt|question)"\s*:\s*[^,}]+/gi, '"$1":"…"')
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.slice(0, ERROR_LIMIT);
}

export interface AgentRunStart {
  companyId: string;
  conversationId: string;
  /** Предыдущая попытка, если эта — повтор после таймаута или обрыва. */
  retryOf?: string | null;
  model?: string | null;
}

export interface AgentRunFinish {
  outcome: AgentRunOutcome;
  messageId?: string | null;
  escalationId?: string | null;
  knowledgeEntryIds?: string[];
  promptTokens?: number | null;
  completionTokens?: number | null;
  error?: unknown;
}

/**
 * Открыть строку попытки. Возвращает её идентификатор — по нему попытку
 * закрывают и на него ссылается повтор.
 *
 * Пусто означает, что журнал недоступен: вызывающий код обязан продолжать
 * работу как ни в чём не бывало.
 */
export async function startAgentRun(input: AgentRunStart): Promise<string | null> {
  try {
    const row = await prisma.agentRun.create({
      data: {
        companyId: input.companyId,
        conversationId: input.conversationId,
        triggeredAt: new Date(),
        // Пока попытка идёт, исход неизвестен. Ошибку ставим по умолчанию:
        // процесс может умереть на середине, и незакрытая строка не должна
        // выглядеть успехом.
        outcome: "PROVIDER_ERROR",
        knowledgeEntryIds: [],
        model: input.model ?? null,
        retryOf: input.retryOf ?? null,
      },
      select: { id: true },
    });
    return row.id;
  } catch {
    return null;
  }
}

/** Закрыть строку попытки. Молча ничего не делает, если строки нет. */
export async function finishAgentRun(id: string | null, result: AgentRunFinish): Promise<void> {
  if (!id) return;
  try {
    const started = await prisma.agentRun.findUnique({
      where: { id },
      select: { triggeredAt: true },
    });
    const finishedAt = new Date();
    await prisma.agentRun.update({
      where: { id },
      data: {
        finishedAt,
        latencyMs: started ? finishedAt.getTime() - started.triggeredAt.getTime() : null,
        outcome: result.outcome,
        messageId: result.messageId ?? null,
        escalationId: result.escalationId ?? null,
        knowledgeEntryIds: result.knowledgeEntryIds ?? [],
        promptTokens: result.promptTokens ?? null,
        completionTokens: result.completionTokens ?? null,
        errorText: sanitizeError(result.error),
      },
    });
  } catch {
    // Журнал не должен ронять ответ пациенту.
  }
}

/**
 * Записать попытку целиком — когда её исход известен сразу.
 *
 * Так пишутся SUPPRESSED (агент промолчал намеренно) и ESCALATED без
 * обращения к модели: там нечего засекать, событие мгновенное.
 */
export async function logAgentRun(
  input: AgentRunStart & AgentRunFinish,
): Promise<void> {
  try {
    const now = new Date();
    await prisma.agentRun.create({
      data: {
        companyId: input.companyId,
        conversationId: input.conversationId,
        triggeredAt: now,
        finishedAt: now,
        latencyMs: 0,
        outcome: input.outcome,
        messageId: input.messageId ?? null,
        escalationId: input.escalationId ?? null,
        knowledgeEntryIds: input.knowledgeEntryIds ?? [],
        model: input.model ?? null,
        promptTokens: input.promptTokens ?? null,
        completionTokens: input.completionTokens ?? null,
        errorText: sanitizeError(input.error),
        retryOf: input.retryOf ?? null,
      },
    });
  } catch {
    // См. выше: наблюдаемость не важнее работы клиники.
  }
}
