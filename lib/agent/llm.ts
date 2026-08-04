import { CLINIC_NAME } from "@/lib/brand";

/**
 * Ответ пациенту по справке клиники. Тот же провайдер, что у ассистента в
 * панели (routerai.ru, OpenAI-совместимый), но промпт другой: здесь собеседник
 * — пациент, а не сотрудник.
 *
 * В модель уходит только справочник клиники (услуги, цены, часы) и текущий
 * вопрос. Персональные данные и медицинская информация не передаются (§7).
 * Нет ключа или сбой — возвращаем null, и агент честно говорит, что не знает,
 * вместо выдумки.
 */
const BASE_URL = (process.env.ROUTER_AI_BASE_URL || "https://routerai.ru/api/v1").replace(/\/+$/, "");
const MODEL = process.env.ROUTER_AI_MODEL || "anthropic/claude-opus-4.8-fast";

const PATIENT_PROMPT = [
  `Ты — администратор клиники «${CLINIC_NAME}» в мессенджере.`,
  "Отвечай коротко и по-человечески, на «вы», 1–3 предложения, без разметки и списков.",
  "Опирайся СТРОГО на справку клиники ниже: услуги, цены, часы работы, адрес.",
  "Если в справке ответа нет — так и скажи и предложи позвать администратора. Ничего не выдумывай.",
  "НИКОГДА не обсуждай симптомы, диагнозы, лечение, препараты, противопоказания и результаты анализов:",
  "на такие вопросы отвечай, что позовёшь специалиста.",
  "Не запрашивай персональные данные, кроме имени. Не обещай того, чего нет в справке.",
  "Не используй разметку: никаких #, *, списков со звёздочками. Пиши обычным текстом.",
].join(" ");

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

/**
 * history — последние реплики диалога. Без неё ассистент отвечал на каждое
 * сообщение как на первое: «а сколько это стоит?» после вопроса об остеопатии
 * он уже не понимал.
 */
export async function answerLLM(
  question: string,
  clinicContext: string,
  history: Turn[] = [],
): Promise<string | null> {
  const key = process.env.ROUTER_AI;
  if (!key) return null;

  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        max_tokens: 400,
        messages: [
          { role: "system", content: PATIENT_PROMPT },
          { role: "system", content: `Справка клиники:\n${clinicContext}` },
          // Последние реплики — чтобы «а сколько это стоит?» понималось в контексте.
          ...history.slice(-10),
          { role: "user", content: question },
        ],
      }),
      // Вебхук должен уложиться в лимит serverless-функции (на Hobby 10 с),
      // иначе Telegram не дождётся ответа и пришлёт сообщение повторно.
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = json.choices?.[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
