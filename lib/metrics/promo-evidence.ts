/**
 * Пришёл ли пациент от школы, если метку из ссылки стёрли, — улика в переписке.
 *
 * Модель только ЧИТАЕТ и называет сообщение с цитатой; решение принимает код, а
 * окончательное — человек (привязка уходит «на проверку», бонуса до
 * подтверждения нет). Здесь только чистые правила: что отправить модели, как
 * разобрать её ответ и как проверить, что цитата настоящая.
 *
 * Что уходит модели (решение заказчика, 20 октября; §7 — с обезличиванием):
 * первые 15 сообщений обращения с ролью автора, телефоны и почта вырезаны,
 * имена заменены, уведомления YCLIENTS убраны; название школы и её синонимы.
 * Ничего из карточки пациента и его визитов.
 */

import { z } from "zod";
import { maskPhones } from "@/lib/assistant/admin-understand";
import { parseNotice } from "./yclients-notice";

export const EVIDENCE_MESSAGES = 15;

export interface DialogMessageForCheck {
  id: string;
  direction: "IN" | "OUT";
  authorType: "PATIENT" | "BOT" | "STAFF";
  body: string;
  createdAt: Date;
}

export interface EvidenceInput {
  /** Строки для модели: «m3 · пациент: …». */
  lines: string[];
  /** Номер для модели → сообщение. */
  byRef: Map<string, { id: string; author: DialogMessageForCheck["authorType"]; masked: string; createdAt: Date }>;
  school: string;
  aliases: string[];
}

const ROLE: Record<DialogMessageForCheck["authorType"], string> = { PATIENT: "пациент", BOT: "клиника (бот)", STAFF: "клиника" };

/** Почта, телефоны и имена — вон. Слова школы остаются: по ним модель и узнаёт улику. */
export function maskForModel(text: string, keep: string[], names: string[]): string {
  const keepStems = keep
    .flatMap((k) => k.toLowerCase().replace(/ё/g, "е").split(/[^\p{L}]+/u))
    .filter((w) => w.length >= 4)
    .map((w) => w.slice(0, Math.max(4, w.length - 2)));
  const nameStems = names
    .flatMap((n) => n.toLowerCase().replace(/ё/g, "е").split(/[^\p{L}]+/u))
    .filter((w) => w.length >= 3)
    .map((w) => w.slice(0, Math.max(3, w.length - 2)));
  let out = maskPhones(text).text.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[ПОЧТА]");
  // Слова с заглавной посреди фразы и известные имена — «[ИМЯ]», если это не слово школы.
  out = out.replace(/(?<=[^\s.!?…]\s+|^)(\p{Lu}\p{Ll}{2,})/gu, (w, _m, offset: number) => {
    const low = w.toLowerCase().replace(/ё/g, "е");
    if (keepStems.some((st) => low.startsWith(st))) return w;
    const sentenceStart = offset === 0 || /[.!?…]\s*$/u.test(out.slice(0, offset));
    if (sentenceStart && !nameStems.some((st) => low.startsWith(st))) return w;
    return "[ИМЯ]";
  });
  return out.replace(/\p{L}+/gu, (w) => {
    const low = w.toLowerCase().replace(/ё/g, "е");
    if (keepStems.some((st) => low.startsWith(st))) return w;
    return nameStems.some((st) => low.length >= 3 && low.startsWith(st)) ? "[ИМЯ]" : w;
  });
}

/** Уведомления YCLIENTS — не разговор, модели они не нужны. */
export function isYclientsNotice(m: Pick<DialogMessageForCheck, "direction" | "body">): boolean {
  return m.direction === "OUT" && parseNotice(m.body) !== null;
}

export function buildEvidenceInput(
  messages: DialogMessageForCheck[],
  school: string,
  aliases: string[],
  names: string[],
): EvidenceInput {
  const keep = [school, ...aliases];
  const picked = [...messages]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .filter((m) => m.body.trim() && !isYclientsNotice(m))
    .slice(0, EVIDENCE_MESSAGES);
  const byRef: EvidenceInput["byRef"] = new Map();
  const lines = picked.map((m, i) => {
    const ref = `m${i + 1}`;
    const masked = maskForModel(m.body, keep, names).slice(0, 600);
    byRef.set(ref, { id: m.id, author: m.authorType, masked, createdAt: m.createdAt });
    return `${ref} · ${ROLE[m.authorType]}: ${masked.replace(/\s+/g, " ")}`;
  });
  return { lines, byRef, school, aliases };
}

export function evidencePrompt(input: EvidenceInput): { system: string; user: string } {
  const system = [
    "Ты читаешь начало переписки клиники с пациентом и отвечаешь на один вопрос: связал ли ПАЦИЕНТ своё обращение со школой подготовки.",
    "true — только если пациент сам прямо написал, что узнал о клинике или акции от этой школы (от педагога, на собрании, по рассылке школы и т.п.).",
    "Возраст ребёнка, сама услуга, «наверное», «кажется», слова клиники — не основание: null.",
    "Instagram, блогер, реклама, знакомые без упоминания школы — false.",
    "Ответ — только JSON без пояснений вокруг:",
    '{"fromSchool": true|false|null, "evidenceMessageId": "m3"|null, "evidenceQuote": "дословная цитата из этого сообщения"|null, "reason": "коротко, почему"}',
    "evidenceMessageId и evidenceQuote — только при true; цитата — дословно из сообщения пациента, без пересказа.",
  ].join("\n");
  const user = [
    `Школа: ${input.school}${input.aliases.length ? ` (ещё называют: ${input.aliases.join(", ")})` : ""}`,
    "Переписка:",
    ...input.lines,
  ].join("\n");
  return { system, user };
}

const Answer = z.object({
  fromSchool: z.boolean().nullable(),
  evidenceMessageId: z.string().nullable().optional(),
  evidenceQuote: z.string().nullable().optional(),
  reason: z.string().max(500).optional().default(""),
});
export type EvidenceAnswer = z.infer<typeof Answer>;

/** Ответ модели → структура. Не JSON или не по форме — null (это «ошибка модели»). */
export function parseEvidenceAnswer(raw: string): EvidenceAnswer | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = Answer.safeParse(JSON.parse(m[0]));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type EvidenceVerdict =
  | { result: "ATTRIBUTED"; messageId: string; quote: string; at: Date }
  | { result: "NOT_FROM_SCHOOL" | "UNCLEAR" | "REJECTED_BY_VERIFIER"; reason: string };

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[«»"„“]/g, "").replace(/\s+/g, " ").trim();

/**
 * Проверка кодом — без неё привязки нет: модель сказала «да», назвала
 * сообщение, оно в этой переписке, написал его ПАЦИЕНТ, и цитата после
 * нормализации — дословный кусок его текста.
 */
export function verifyEvidence(answer: EvidenceAnswer, input: EvidenceInput): EvidenceVerdict {
  if (answer.fromSchool === false) return { result: "NOT_FROM_SCHOOL", reason: answer.reason || "пациент о школе не говорил" };
  if (answer.fromSchool !== true) return { result: "UNCLEAR", reason: answer.reason || "неясно" };
  const ref = answer.evidenceMessageId?.trim() ?? "";
  const msg = input.byRef.get(ref);
  if (!msg) return { result: "REJECTED_BY_VERIFIER", reason: "модель назвала сообщение, которого нет в переписке" };
  if (msg.author !== "PATIENT") return { result: "REJECTED_BY_VERIFIER", reason: "цитата из сообщения клиники, а не пациента" };
  const quote = norm(answer.evidenceQuote ?? "");
  if (quote.length < 4) return { result: "REJECTED_BY_VERIFIER", reason: "цитаты нет" };
  if (!norm(msg.masked).includes(quote)) return { result: "REJECTED_BY_VERIFIER", reason: "цитаты нет в тексте сообщения" };
  return { result: "ATTRIBUTED", messageId: msg.id, quote: (answer.evidenceQuote ?? "").trim().slice(0, 300), at: msg.createdAt };
}

// ─────────────────────────────────────────────── «назвала другую школу»

/**
 * Пришла по фразе «школьный ресурс», а в переписке назвала другую школу или
 * другой источник (заказчик, 20 октября: «если где-то в чате она скажет, что
 * она с какой-то другой школы, ИИ это увидит и занесёт»). Метка-фраза — не
 * доказательство: её напишет и тот, кто узнал об акции не от нашей школы.
 *
 * Модель только находит и цитирует; привязка уходит «на проверку», бонус ждёт
 * решения человека. Сама модель привязку не снимает.
 */

/**
 * Без модели: есть ли в словах пациента хоть что-то об источнике. Нет — модель
 * не зовём вовсе: у большинства мам переписка — запись и вопросы о времени, и
 * платить за чтение каждой нечего. Сама фраза-метка в счёт не идёт: в ней слово
 * «школьный».
 */
export function mentionsSource(patientTexts: string[], marker: string): boolean {
  const markerWords = marker.toLowerCase().replace(/ё/g, "е").split(/[^\p{L}]+/u).filter((w) => w.length >= 3);
  return patientTexts.some((raw) => {
    let t = raw.toLowerCase().replace(/ё/g, "е");
    // Убираем фразу-метку целиком (в любом падеже): «школьный ресурс», «школьного ресурса».
    if (markerWords.length >= 2) {
      const re = new RegExp(markerWords.map((w) => `${w.slice(0, Math.max(4, w.length - 2))}\\p{L}*`).join("[^\\p{L}]+"), "gu");
      t = t.replace(re, " ");
    }
    return /(?<!\p{L})(?:школ\p{L}*|садик\p{L}*|детск\p{L}*\s+сад\p{L}*|гимнази\p{L}*|лице\p{L}*|центр\p{L}*|подготов\p{L}*|педагог\p{L}*|учител\p{L}*|воспитател\p{L}*|инстагр\p{L}*|instagram|блогер\p{L}*|реклам\p{L}*|посоветова\p{L}*|порекомендова\p{L}*|знаком\p{L}*|подруг\p{L}*)/u.test(t);
  });
}

export function contradictionPrompt(input: EvidenceInput): { system: string; user: string } {
  const system = [
    `Пациент написал в клинику по ссылке школы подготовки «${input.school}». Ты читаешь переписку и отвечаешь на один вопрос: назвал ли ПАЦИЕНТ прямо ДРУГОЙ источник — другую школу, садик, центр, педагога другой школы, Instagram, блогера, рекламу, знакомых.`,
    `true — только если пациент сам прямо так написал («мы из школы №5», «в садике посоветовали», «увидела у блогера»). Упоминание «${input.school}»${input.aliases.length ? ` или ${input.aliases.join(", ")}` : ""} — это НЕ другой источник.`,
    "Слова клиники, сама услуга, «школьный ресурс», возраст ребёнка, «наверное» — не основание: null. Источник не назван вовсе — false.",
    "Ответ — только JSON без пояснений вокруг:",
    '{"otherSource": true|false|null, "evidenceMessageId": "m3"|null, "evidenceQuote": "дословная цитата из этого сообщения"|null, "reason": "коротко, какой источник назван"}',
    "evidenceMessageId и evidenceQuote — только при true; цитата — дословно из сообщения пациента, без пересказа.",
  ].join("\n");
  const user = [
    `Наша школа: ${input.school}${input.aliases.length ? ` (ещё называют: ${input.aliases.join(", ")})` : ""}`,
    "Переписка:",
    ...input.lines,
  ].join("\n");
  return { system, user };
}

const ContraAnswer = z.object({
  otherSource: z.boolean().nullable(),
  evidenceMessageId: z.string().nullable().optional(),
  evidenceQuote: z.string().nullable().optional(),
  reason: z.string().max(500).optional().default(""),
});

/** Ответ модели → та же форма, что у поиска улики: «да» значит «назван другой источник». */
export function parseContradictionAnswer(raw: string): EvidenceAnswer | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = ContraAnswer.safeParse(JSON.parse(m[0]));
    if (!parsed.success) return null;
    const a = parsed.data;
    return { fromSchool: a.otherSource, evidenceMessageId: a.evidenceMessageId, evidenceQuote: a.evidenceQuote, reason: a.reason };
  } catch {
    return null;
  }
}
