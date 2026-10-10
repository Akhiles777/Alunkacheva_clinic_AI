import { bookingPromiseFound } from "./booking-promise";
import { asksForConsent } from "./consent";
import { asksForIntake, asksForPersonalData } from "./intake";
import { foreignScriptWords } from "./grounding";

/**
 * Живые слова для шага записи — модель пишет, код проверяет.
 *
 * Шаги записи («к кому хотите?» → «к Ирине») отвечал код шаблоном, потому что
 * модель на этом месте врала: называла чужую цену, длительность то 20, то 30
 * минут, забывала спросить данные. Шаблон был верным и деревянным: «Хорошо.
 * Ирина Алилгаджиевна: Взрослый прием - остеопатия — 8000 ₽, 45 мин.» Заказчик
 * сказал прямо: агент стал глупее (4 октября).
 *
 * Разделение такое: ЧТО сказать решает код (врач, услуга, цена, следующий
 * шаг), КАК сказать — модель, одним-двумя предложениями подтверждения. Вопрос
 * следующего шага и запрос согласия ставит код дословно: потеряться они не
 * могут. Текст модели проверяется здесь; не прошёл — уходит шаблон.
 */

export interface StepFacts {
  /** Врач, которого выбрал пациент (как к нему обращаются). */
  doctor: string | null;
  /** Строка прайса, если услуга выбрана однозначно. */
  service: { title: string; price: number; durationMin: number } | null;
  whom: "child" | "adult" | "unknown";
  /** Что пациент только что написал. */
  patientMessage: string;
}

/** Факты одним блоком — ровно то, что модели можно сказать. */
export function factsBlock(f: StepFacts): string {
  const lines: string[] = [];
  if (f.doctor) lines.push(`Врач: ${f.doctor}`);
  if (f.service) {
    const dur = f.service.durationMin > 0 ? `, длительность ${f.service.durationMin} мин` : "";
    lines.push(`Услуга: ${f.service.title} — ${f.service.price} ₽${dur}`);
  }
  if (f.whom === "child") lines.push("Приём для ребёнка");
  if (f.whom === "adult") lines.push("Приём для взрослого");
  return lines.join("\n");
}

/** Числа текста без пробелов внутри: «8 000» и «8000» — одно число. */
function numbersIn(text: string): string[] {
  return [...text.matchAll(/\d+(?:[  ]\d{3})*/g)].map((m) => m[0].replace(/[  ]/g, ""));
}

/** Упомянут ли сотрудник хоть одним словом имени. */
function mentions(text: string, name: string): boolean {
  const t = text.toLowerCase().replace(/ё/g, "е");
  return name
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/\s+/)
    .filter((w) => w.length >= 4)
    .some((w) => new RegExp(`(?<!\\p{L})${w.slice(0, Math.min(5, w.length - 1))}`, "u").test(t));
}

/**
 * Что не так с подтверждением модели. null — можно отправлять.
 *
 * Проверяем то, из-за чего шаги записи и перевели на код:
 *   • число не из фактов (цена, длительность) — выдумка;
 *   • назван врач, которого человек не выбирал, — подмена;
 *   • обещание записать, просьба данных или согласия — это ставит код,
 *     дважды в одном сообщении им быть нельзя;
 *   • вопрос — следующий вопрос ставит код, второй сбивает человека.
 */
export function confirmationProblem(text: string, f: StepFacts, staffNames: string[]): string | null {
  const t = text.trim();
  if (!t) return "пусто";
  if (t.length > 400) return "слишком длинно";
  if (t.includes("?")) return "свой вопрос";
  if (bookingPromiseFound(t)) return "обещание записать";
  if (asksForPersonalData(t) || asksForIntake(t) || asksForConsent(t)) return "просьба данных или согласия";
  // Про администратора и время говорит код: «администратор сейчас подберёт» — обещание срока.
  if (/(?<!\p{L})(?:администратор\p{L}*|подбер\p{L}*|свободн\p{L}*|окош\p{L}*|окн[оа](?!\p{L}))/iu.test(t)) {
    return "про администратора или время";
  }

  const allowed = new Set([...numbersIn(factsBlock(f)), ...numbersIn(f.patientMessage)]);
  const stray = numbersIn(t).find((n) => !allowed.has(n));
  if (stray) return `число не из фактов: ${stray}`;

  /**
   * Подтверждение выбора — факт, а не рассуждение о себе. Haiku 5.5 писала
   * «Цену и длительность пока не знаю, поэтому назову их позже» (цены стояли
   * строкой ниже) и «Сейчас уточню детали приёма» — обещание, которого никто
   * не выполнит (прогон 9 октября).
   */
  if (
    /(?<!\p{L})(?:не\s+знаю|пока\s+не|позже|назову|уточн\p{L}*|сейчас\s+(?:я\s+)?(?:посмотр|провер|узна)\p{L}*|помогу|с\s+радостью)(?!\p{L})/iu.test(t)
  ) {
    return "рассуждение или обещание";
  }
  /**
   * Речь о собственных данных — пациенту не говорят «в фактах их нет». Снимок
   * боевых данных 9 октября: «Цену и длительность сейчас не называю, так как в
   * фактах их нет» ушло живым подтверждением выбора.
   */
  if (
    /(?<!\p{L})(?:факт\p{L}*|не\s+называ\p{L}*|не\s+указан\p{L}*|нет\s+(?:данных|информации|сведений)|(?:данных|информации|сведений)\s+нет|в\s+списке|в\s+справк\p{L}*)(?!\p{L})/iu.test(t)
  ) {
    return "речь о своих данных";
  }

  // «Ваalaйкум» — латиница посреди русской фразы (прогон 9 октября).
  const odd = foreignScriptWords(t, `${factsBlock(f)}\n${f.patientMessage}`);
  if (odd.length > 0) return `не тот алфавит: ${odd.join(", ")}`;

  const foreign = staffNames.find((name) => namesOther(t, name, f.doctor));
  if (foreign) return `чужой врач: ${foreign}`;
  const garbled = garbledName(t, staffNames);
  if (garbled) return `искажено имя: ${garbled}`;
  return null;
}

/**
 * Слово похоже на имя сотрудника, но это не его форма: «Ирины Алилгаджиевой»
 * вместо «Алилгаджиевны» (прогон 5 октября). Падеж меняет только окончание,
 * поэтому форма обязана начинаться с имени без последней буквы
 * («Алилгаджиевн…», «Ирин…», «Омаров…»). Искажённое отчество врача в сообщении
 * клиники читается как небрежность — уходит шаблон.
 */
function garbledName(text: string, staffNames: string[]): string | null {
  const parts = staffNames
    .flatMap((n) => n.toLowerCase().replace(/ё/g, "е").split(/\s+/))
    .filter((w) => w.length >= 5);
  for (const raw of text.match(/\p{Lu}\p{Ll}{3,}/gu) ?? []) {
    const w = raw.toLowerCase().replace(/ё/g, "е");
    const kin = parts.filter((p) => w.slice(0, 5) === p.slice(0, 5));
    if (kin.length > 0 && !kin.some((p) => w.startsWith(p.slice(0, p.length - 1)))) return raw;
  }
  return null;
}

/**
 * Текст называет этого сотрудника, и это не выбранный врач. Общие с выбранным
 * слова не в счёт: «Ирина» в «Ирина Алилгаджиевна» не делает упоминанием
 * Ирину Омарову.
 */
function namesOther(text: string, name: string, chosen: string | null): boolean {
  const words = (s: string) => s.toLowerCase().replace(/ё/g, "е").split(/\s+/).filter((w) => w.length >= 4);
  const mine = chosen ? words(chosen) : [];
  // Это и есть выбранный врач: «Алункачева Ирина Алилгаджиевна» ⊇ «Ирина Алилгаджиевна».
  if (mine.length > 0 && mine.every((w) => words(name).includes(w))) return false;
  return words(name)
    .filter((w) => !mine.includes(w))
    .some((w) => mentions(text, w));
}
