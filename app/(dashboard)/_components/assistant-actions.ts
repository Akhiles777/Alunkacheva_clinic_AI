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

import { getSession } from "@/lib/server/session";
import { can } from "@/lib/server/authz";
import { buildClinicSnapshot } from "@/lib/assistant/server-context";
import { personaFor } from "@/lib/assistant/personas";
import { toPlainText } from "@/lib/assistant/plain-text";

/**
 * Ассистент говорит от роли вошедшего сотрудника. Роль берём из сессии, а не
 * из аргумента: клиент мог бы попросить чужую роль, а вместе с ней и чужой
 * взгляд на данные.
 */
export type AiPersona = "auto" | "owner";

export interface AiResult {
  text: string | null;
  error?: string;
}

export interface AiTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Обрезать по последнему законченному предложению.
 *
 * Если законченных предложений нет вовсе (ответ короче одного), возвращаем как
 * есть: пустота хуже обрывка.
 */
function trimToSentence(text: string): string {
  const cut = Math.max(text.lastIndexOf("."), text.lastIndexOf("!"), text.lastIndexOf("?"));
  return cut > 40 ? text.slice(0, cut + 1) : text;
}

export async function askAI(
  question: string,
  context: string,
  history: AiTurn[] = [],
  persona: AiPersona = "auto",
): Promise<AiResult> {
  const key = process.env.ROUTER_AI;
  if (!key) return { text: null, error: "not_configured" };

  const session = await getSession();
  const canSeeRevenue = await can(session, "VIEW_REVENUE");

  /**
   * Данные для анализа собираем здесь, на сервере, из базы.
   *
   * Экран присылал выжимку из своего стора, а туда попадает только то, что
   * ему нужно: расписание на сегодня и список пациентов без визитов. Поэтому
   * аналитик владельца отвечал лишь про сегодняшний день и не знал ни истории
   * визитов, ни выручки, ни услуг — данных ему просто не давали.
   *
   * Присланное экраном оставляем рядом: там есть то, что человек видит прямо
   * сейчас, и вопрос может быть про это.
   */
  const snapshot = await buildClinicSnapshot(session.companyId).catch(() => "");
  const fullContext = snapshot ? `${snapshot}\n\n# Что открыто на экране\n${context}` : context;
  // «owner» — отдельный экран кабинета владельца; там роль задана самим
  // разделом, но право на выручку всё равно проверяем.
  const role = persona === "owner" ? "OWNER" : session.role;
  const systemPrompt = personaFor(role, canSeeRevenue);

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
        /**
         * Запас намеренно выше ожидаемой длины: краткость задаётся промптом, а
         * не обрезкой. Обрыв ответа на полуслове хуже длинного ответа.
         *
         * Девятисот не хватало. На просьбу «проведи глубокий анализ» разбор
         * обрывался словом «Важн» — владелец видел половину мысли и не мог
         * понять, это всё или связь пропала.
         */
        max_tokens: 1800,
        messages: [
          // Инструкции + свежий срез базы. Пересобираем каждый запрос — данные
          // могли измениться между репликами.
          { role: "system", content: `${systemPrompt}\n\nДанные (только чтение):\n${fullContext}` },
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
      choices?: { message?: { content?: string }; finish_reason?: string }[];
    };
    /**
     * Разметку снимаем на выходе.
     *
     * Просьбы в промпте модель соблюдает через раз, а ответ уходит человеку
     * каждый раз: владелец видел «провела **39 визитов**» со звёздочками.
     */
    const choice = data.choices?.[0];
    const text = toPlainText(choice?.message?.content?.trim() ?? "");
    if (text.length === 0) return { text: null };

    /**
     * Ответ упёрся в лимит — обрываем по последнему законченному предложению
     * и говорим об этом прямо.
     *
     * Половина слова на экране выглядит как оборванная связь, и владелец не
     * знает, всё ли это. Оборванная мысль хуже короткой: по ней нельзя понять,
     * что вывод не дописан.
     */
    if (choice?.finish_reason === "length") {
      return { text: `${trimToSentence(text)}\n\n(Разбор длиннее, чем помещается в один ответ. Спросите «продолжи» — досказу.)` };
    }
    return { text };
  } catch (e) {
    return { text: null, error: e instanceof Error ? e.name : "unknown" };
  } finally {
    clearTimeout(timeout);
  }
}
