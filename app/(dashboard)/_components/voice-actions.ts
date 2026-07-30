"use server";

/**
 * Синтез речи через routerai.ru (нейросетевой TTS — живой голос, как у ChatGPT,
 * а не роботизированный системный). Ключ ROUTER_AI живёт только на сервере.
 * Возвращаем mp3 в base64 — браузер играет напрямую. Если недоступно — null,
 * и клиент падает на системный Web Speech.
 */
const BASE_URL = (process.env.ROUTER_AI_BASE_URL || "https://routerai.ru/api/v1").replace(/\/+$/, "");
const TTS_MODEL = process.env.ROUTER_AI_TTS_MODEL || "minimax/speech-2.8-turbo";
const TTS_VOICE = process.env.ROUTER_AI_TTS_VOICE || "nova";

export interface SpeechResult {
  audioBase64: string | null;
  mime: string;
  error?: string;
}

export async function synthesizeSpeech(text: string, voice?: string): Promise<SpeechResult> {
  const key = process.env.ROUTER_AI;
  const input = text.trim().slice(0, 1200); // ограничиваем длину — латентность и цена
  if (!key || !input) return { audioBase64: null, mime: "audio/mpeg", error: "not_configured" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${BASE_URL}/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: TTS_MODEL,
        voice: voice || TTS_VOICE,
        input,
        response_format: "mp3",
      }),
      signal: controller.signal,
    });
    if (!res.ok) return { audioBase64: null, mime: "audio/mpeg", error: `http_${res.status}` };
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("json")) return { audioBase64: null, mime: "audio/mpeg", error: "not_audio" };
    const buf = Buffer.from(await res.arrayBuffer());
    return { audioBase64: buf.toString("base64"), mime: "audio/mpeg" };
  } catch (e) {
    return { audioBase64: null, mime: "audio/mpeg", error: e instanceof Error ? e.name : "unknown" };
  } finally {
    clearTimeout(timeout);
  }
}
