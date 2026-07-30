"use server";

/**
 * Реальный ИИ через routerai.ru (OpenAI-совместимый). Ключ ROUTER_AI живёт
 * только на сервере и в браузер не попадает. Ассистенту даём аналитическую
 * выжимку базы ТОЛЬКО НА ЧТЕНИЕ; медицинские советы/диагнозы — вне его зоны
 * (§6). Если ключ не задан или вызов упал — возвращаем null, и клиент отвечает
 * локальным движком (не ломаемся).
 */
const BASE_URL = (process.env.ROUTER_AI_BASE_URL || "https://routerai.ru/api/v1").replace(/\/+$/, "");
// Сильнейшее семейство (Opus 4.8), но быстрый вариант — важно для голоса и чтобы
// не упереться в таймаут и не свалиться в шаблонный локальный фоллбэк.
const MODEL = process.env.ROUTER_AI_MODEL || "anthropic/claude-opus-4.8-fast";

const SYSTEM_PROMPT = [
  "Ты — ассистент-аналитик CRM частной клиники «Мера».",
  "У тебя доступ ТОЛЬКО НА ЧТЕНИЕ к аналитической выжимке базы (она в сообщении пользователя).",
  "Отвечай кратко, по-русски, опираясь СТРОГО на эти данные — не выдумывай цифры и факты.",
  "Не давай медицинских советов, не обсуждай диагнозы, симптомы и лечение — это не твоя зона.",
  "Если данных для ответа нет — честно скажи об этом.",
].join(" ");

const OWNER_PROMPT = [
  "Ты — сильный личный бизнес-аналитик владельца частной клиники «Мера», уровня топового консультанта.",
  "Проводишь ГЛУБОКИЙ, НЕ ШАБЛОННЫЙ анализ по данным ниже (только чтение): загрузка кабинетов и сотрудников,",
  "часы работы, выручка и средний чек, воронка, удержание и курсы, неявки, интервалы визитов.",
  "Опирайся на КОНКРЕТНЫЕ ЦИФРЫ из данных, считай производные показатели (потери от простоя,",
  "недополученную выручку, вклад каждого специалиста), сравнивай, ищи первопричину, а не симптом.",
  "Выдвигай приоритизированные гипотезы и давай измеримые рекомендации: что сделать, какой эффект в рублях/процентах.",
  "Пиши живым связным текстом (ответ могут слушать голосом), без таблиц и разметки, разбивай на короткие абзацы.",
  "Не повторяй одно и то же общими словами. Не давай медицинских советов и не обсуждай диагнозы/лечение.",
].join(" ");

const PERSONAS = { assistant: SYSTEM_PROMPT, owner: OWNER_PROMPT } as const;
export type AiPersona = keyof typeof PERSONAS;

export interface AiResult {
  text: string | null;
  error?: string;
}

export interface AiTurn {
  role: "user" | "assistant";
  content: string;
}

export async function askAI(
  question: string,
  context: string,
  history: AiTurn[] = [],
  persona: AiPersona = "assistant",
): Promise<AiResult> {
  const key = process.env.ROUTER_AI;
  if (!key) return { text: null, error: "not_configured" };
  const systemPrompt = PERSONAS[persona] ?? SYSTEM_PROMPT;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 40_000);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.4,
        max_tokens: 1100,
        messages: [
          // Инструкции + свежий срез базы. Пересобираем каждый запрос — данные
          // могли измениться между репликами.
          { role: "system", content: `${systemPrompt}\n\nДанные (только чтение):\n${context}` },
          // Память диалога: предыдущие реплики, чтобы ИИ понимал контекст беседы.
          ...history.slice(-12).map((t) => ({ role: t.role, content: t.content })),
          { role: "user", content: question },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return { text: null, error: `http_${res.status}` };
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    return { text: text && text.length > 0 ? text : null };
  } catch (e) {
    return { text: null, error: e instanceof Error ? e.name : "unknown" };
  } finally {
    clearTimeout(timeout);
  }
}
