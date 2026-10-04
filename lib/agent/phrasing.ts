import { bookingPromiseFound } from "./booking-promise";
import { asksForConsent } from "./consent";
import { asksForIntake, asksForPersonalData } from "./intake";

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

  const allowed = new Set([...numbersIn(factsBlock(f)), ...numbersIn(f.patientMessage)]);
  const stray = numbersIn(t).find((n) => !allowed.has(n));
  if (stray) return `число не из фактов: ${stray}`;

  const foreign = staffNames.find((name) => namesOther(t, name, f.doctor));
  if (foreign) return `чужой врач: ${foreign}`;
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
