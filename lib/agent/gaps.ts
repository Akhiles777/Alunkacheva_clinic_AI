/**
 * Пробелы в справочнике: о чём пациенты спрашивают, а ответить нечем.
 *
 * Каждая эскалация «не понял запрос» и «медицинский вопрос без готового
 * ответа» — это вопрос, на который у клиники нет заведённого ответа. По
 * одному такому случаю ничего не видно; повторяющийся вопрос — это работа,
 * которую администратор делает руками каждую неделю, и её можно снять одной
 * записью справочника.
 *
 * Похожие вопросы группируем простой нормализацией и пересечением слов — тем
 * же разбором, которым агент ищет ответ (`knowledge.ts`). Векторную базу сюда
 * не тащим: вопросов в клинике десятки, а не миллионы, и цена ошибки здесь
 * нулевая — человек всё равно читает группу глазами, прежде чем что-то с ней
 * делать.
 *
 * ГЛАВНОЕ ПРАВИЛО: этот модуль ничего не создаёт. Он показывает и предлагает.
 * Запись справочника появляется только тогда, когда человек прочитал текст,
 * поправил его и нажал «Сохранить». Ответ администратора в переписке —
 * не готовая справка: он писал конкретному пациенту, зная его случай, а
 * справка отвечает всем.
 */

/** Значимые слова вопроса: без служебных, приведённые к основе. */
import { stemsOf } from "./knowledge";

export interface GapAnswer {
  /** Что ответил сотрудник после эскалации. */
  text: string;
  at: Date;
  authorName: string | null;
}

export interface GapQuestion {
  /** Идентификатор эскалации: по нему группа разворачивается в переписку. */
  id: string;
  conversationId: string;
  text: string;
  at: Date;
  reason: string;
  answer: GapAnswer | null;
}

export interface GapCluster {
  /** Устойчивый ключ группы — по нему экран помнит раскрытые строки. */
  key: string;
  /** Как называется вопрос: самая частая формулировка группы. */
  title: string;
  count: number;
  lastAt: Date;
  /** Поводы эскалаций в группе: «не понял запрос», «медицинский вопрос». */
  reasons: string[];
  /**
   * Медицинская тема. Такую справку клиника утверждает через врача: агент
   * отвечает медицинскими текстами дословно (§6, правило 1), и сочинённое
   * противопоказание — это вред пациенту, а не неточность в тексте.
   */
  medical: boolean;
  questions: GapQuestion[];
  /** Ответы сотрудников по этой группе — сырьё для будущей справки. */
  answers: GapAnswer[];
}

/**
 * Насколько два вопроса про одно и то же.
 *
 * Доля общих слов от более короткого вопроса, а не от объединения: «адрес» и
 * «подскажите пожалуйста ваш адрес и как доехать» — один и тот же вопрос,
 * хотя по объединению совпадение вышло бы 20%.
 */
export function similarity(a: Set<string>, b: Set<string>): number {
  const smaller = a.size <= b.size ? a : b;
  const larger = smaller === a ? b : a;
  if (smaller.size === 0) return 0;
  let common = 0;
  for (const w of smaller) if (larger.has(w)) common += 1;
  return common / smaller.size;
}

/** Совпадение, при котором вопросы считаем одним. */
export const SIMILARITY_MIN = 0.6;

/**
 * Медицинские слова.
 *
 * Список намеренно широкий и намеренно грубый: ошибка в сторону «это
 * медицина» стоит одного лишнего согласования с врачом, ошибка в обратную
 * сторону — сочинённого ответа про противопоказания. Цена этих ошибок разная
 * на порядки, поэтому и порог разный: хватает одного слова.
 */
const MEDICAL_WORDS = [
  "боль", "болит", "болел", "противопоказ", "беремен", "кормлю", "кормящ",
  "лекарств", "препарат", "таблетк", "диагноз", "симптом", "температур",
  "давлен", "аллерг", "побочн", "лечен", "лечить", "обостр", "хронич",
  "операц", "травм", "перелом", "воспален", "инфекц", "антибиотик",
  "гормон", "щитовидк", "онколог", "опухол", "киста", "грыж", "сколиоз",
  "невролог", "гастрит", "язв", "диабет", "астм", "экзем", "псориаз",
  "менструац", "цикл", "гинеколог", "уролог", "простуд", "орви", "ковид",
  "прививк", "вакцин", "анализ", "узи", "мрт", "рентген", "кровь", "крови",
];

/**
 * Похоже ли на медицинский вопрос.
 *
 * Слово из списка в тексте — уже да. Это не диагностика, а маршрутизация:
 * решение «нужен врач» принимает человек, мы только не даём такому вопросу
 * тихо стать обычной справкой.
 */
export function looksMedical(text: string): boolean {
  const lower = text.toLowerCase().replace(/ё/g, "е");
  return MEDICAL_WORDS.some((w) => lower.includes(w));
}

/** Самая частая формулировка группы; при равенстве — самая короткая. */
function titleOf(questions: GapQuestion[]): string {
  const counts = new Map<string, { text: string; n: number }>();
  for (const q of questions) {
    const key = q.text.trim().toLowerCase();
    const cur = counts.get(key);
    if (cur) cur.n += 1;
    else counts.set(key, { text: q.text.trim(), n: 1 });
  }
  return [...counts.values()].sort(
    (a, b) => b.n - a.n || a.text.length - b.text.length || a.text.localeCompare(b.text),
  )[0].text;
}

/**
 * Сгруппировать вопросы без ответа.
 *
 * Жадная склейка: вопрос попадает в первую группу, с которой совпал. Порядок
 * задаём сами — по времени, затем по идентификатору, — чтобы результат не
 * зависел от того, в каком порядке база отдала строки. Иначе одна и та же
 * неделя показывала бы то четыре группы, то шесть.
 */
export function groupGaps(questions: GapQuestion[]): GapCluster[] {
  const ordered = [...questions].sort(
    (a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id),
  );

  const clusters: { stems: Set<string>; items: GapQuestion[] }[] = [];
  for (const q of ordered) {
    const stems = new Set(stemsOf(q.text));
    // Вопрос без значимых слов («?», «алло») группировать не по чему — он не
    // пробел в справочнике, а шум.
    if (stems.size === 0) continue;

    const hit = clusters.find((c) => similarity(c.stems, stems) >= SIMILARITY_MIN);
    if (hit) {
      hit.items.push(q);
      // Ядро группы — только общие слова: иначе группа расползается, приклеивая
      // к «адрес» сначала «адрес и парковка», потом «парковка».
      for (const w of [...hit.stems]) if (!stems.has(w)) hit.stems.delete(w);
    } else {
      clusters.push({ stems, items: [q] });
    }
  }

  return clusters
    .map((c) => {
      const answers = c.items
        .map((q) => q.answer)
        .filter((a): a is GapAnswer => a !== null)
        .sort((a, b) => b.at.getTime() - a.at.getTime());
      const title = titleOf(c.items);
      return {
        key: [...c.stems].sort().join("-") || c.items[0].id,
        title,
        count: c.items.length,
        lastAt: c.items.reduce((max, q) => (q.at > max ? q.at : max), c.items[0].at),
        reasons: [...new Set(c.items.map((q) => q.reason))].sort(),
        /**
         * Медицинской группу делает любой её вопрос, а не большинство: если
         * хоть кто-то спросил про противопоказания, справка по этой группе
         * отвечает и ему тоже.
         */
        medical:
          c.items.some((q) => q.reason === "MEDICAL_QUESTION") ||
          c.items.some((q) => looksMedical(q.text)),
        questions: [...c.items].sort((a, b) => b.at.getTime() - a.at.getTime()),
        answers,
      };
    })
    /** Сверху — то, что спрашивают чаще; при равенстве — что спрашивали позже. */
    .sort((a, b) => b.count - a.count || b.lastAt.getTime() - a.lastAt.getTime());
}
