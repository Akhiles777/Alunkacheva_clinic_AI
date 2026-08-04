"use server";

/**
 * Реальный ИИ через routerai.ru (OpenAI-совместимый). Ключ ROUTER_AI живёт
 * только на сервере и в браузер не попадает. Ассистенту даём аналитическую
 * выжимку базы ТОЛЬКО НА ЧТЕНИЕ; медицинские советы/диагнозы — вне его зоны
 * (§6). Если ключ не задан или вызов упал — возвращаем null, и клиент отвечает
 * локальным движком (не ломаемся).
 */
const BASE_URL = (process.env.ROUTER_AI_BASE_URL || "https://routerai.ru/api/v1").replace(/\/+$/, "");
/**
 * Модель аналитика — Sonnet 4.5. Выбрана по замеру на одинаковом запросе:
 * Opus 4.8 стоил 0.87 за ответ, Sonnet 4.5 — 0.24 при том же качестве разбора
 * и той же длине. Sonnet 5 на этом провайдере непригоден: тратит весь лимит
 * и возвращает пустой ответ (finish_reason = length).
 * Меняется переменной ROUTER_AI_MODEL без правки кода.
 */
const MODEL = process.env.ROUTER_AI_MODEL || "anthropic/claude-sonnet-4.5";

import { CLINIC_NAME } from "@/lib/brand";

const SYSTEM_PROMPT = [
  `Ты — ассистент-аналитик CRM частной клиники «${CLINIC_NAME}».`,
  "У тебя доступ ТОЛЬКО НА ЧТЕНИЕ к аналитической выжимке базы (она в сообщении пользователя).",
  "Отвечай кратко, по-русски, опираясь СТРОГО на эти данные — не выдумывай цифры и факты.",
  "Не давай медицинских советов, не обсуждай диагнозы, симптомы и лечение — это не твоя зона.",
  "Если данных для ответа нет — честно скажи об этом.",
].join(" ");

const OWNER_PROMPT = [
  `Ты — бизнес-аналитик владельца частной клиники «${CLINIC_NAME}».`,
  "Анализируешь данные ниже (только чтение): загрузку кабинетов и сотрудников, выручку и средний чек,",
  "воронку, удержание и курсы, неявки.",
  "Опирайся на КОНКРЕТНЫЕ ЦИФРЫ из данных, ищи первопричину, а не симптом. Не выдумывай значения.",
  // Длина — главный источник расхода. Раньше промпт требовал «глубокий
  // непшаблонный анализ», и модель писала эссе на любой вопрос, даже простой.
  "ОТВЕЧАЙ КОРОТКО: по умолчанию 3–5 предложений, строго по заданному вопросу.",
  "Разворачивай подробно ТОЛЬКО если человек прямо просит: «подробнее», «разбери», «дай гипотезы».",
  "Не пересказывай данные, которые и так видны на экране, и не перечисляй всё подряд — отвечай на спрошенное.",
  "Пиши связным текстом без таблиц и разметки. Не давай медицинских советов и не обсуждай диагнозы/лечение.",
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
        // Запас намеренно выше ожидаемой длины: краткость задаётся промптом, а
        // не обрезкой. Обрыв ответа на полуслове хуже длинного ответа.
        max_tokens: 900,
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
