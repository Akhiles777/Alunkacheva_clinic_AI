/**
 * О чём спросил администратор — разбор вопроса в намерение.
 *
 * Ассистент администратора отвечает КОДОМ: числа он берёт из базы теми же
 * функциями, что рисуют экраны, а не пересказывает модель. Значит вопрос надо
 * привести к одному из известных расчётов — этим здесь и занимаемся.
 *
 * Правила, а не модель, по трём причинам:
 *   1. В вопросе и ответе — визиты, деньги и имена пациентов: это
 *      персональные и медицинские данные, наружу они не уходят (§7).
 *   2. Число, сочинённое моделью, выглядит посчитанным и оказывается неверным
 *      — аналитик владельца уже ошибся так на сотню тысяч (§8).
 *   3. Действие (разослать сообщение пациентам) обязано быть предсказуемым до
 *      последнего получателя. Догадка здесь стоит чужого рабочего дня.
 *
 * Не разобрали вопрос — так и говорим, а не отвечаем «нет доступа»: доступ
 * есть, нет расчёта, и это разные вещи. Список того, что умеем, лежит рядом.
 */

export type AdminIntent =
  | { kind: "help" }
  /** Сколько записано: день, врач, услуга — любая комбинация. */
  | { kind: "day_load"; date: DateRef; staffId: string | null; serviceId: string | null }
  /** Деньги дня: сколько уже принято и сколько записано впереди. */
  | { kind: "day_money"; date: DateRef; staffId: string | null }
  /** Кого ещё предстоит принять сегодня. */
  | { kind: "remaining"; date: DateRef; staffId: string | null }
  /** Кто сейчас на приёме и кто следующий. */
  | { kind: "now"; staffId: string | null }
  /** Свободные окна дня. */
  | { kind: "free_slots"; date: DateRef; staffId: string | null }
  /** Кто не пришёл и что осталось без отметки. */
  | { kind: "attendance"; date: DateRef }
  /** Поимённый список записанных. */
  | { kind: "schedule"; date: DateRef; staffId: string | null; serviceId: string | null }
  /** Кто из пациентов ждёт ответа в переписке. */
  | { kind: "waiting" }
  /** Кому стоит позвонить — та же очередь, что на экране «Кому позвонить». */
  | { kind: "callbacks" }
  /** Сколько новых пациентов появилось. */
  | { kind: "new_patients"; date: DateRef }
  /** Вопрос про конкретного пациента: имя и сам вопрос. */
  | { kind: "patient"; name: string; question: string }
  /** Разослать сообщение записанным. Текст обязателен — иначе отправлять нечего. */
  | {
      kind: "broadcast";
      date: DateRef;
      staffId: string | null;
      serviceId: string | null;
      text: string;
    }
  /** Разобрать не удалось: покажем, что умеем. */
  | { kind: "unknown" };

/** День, о котором спрашивают: смещение в сутках или точная дата. */
export interface DateRef {
  /** Сутки клиники: 0 — сегодня, 1 — завтра, −1 — вчера. */
  offset: number | null;
  /** Точная дата, если названа: «14 сентября», «14.09». */
  iso: string | null;
  /** Как назвать день человеку: «сегодня», «14 сентября». */
  label: string;
}

export interface KnownStaff {
  id: string;
  name: string;
}

export interface KnownService {
  id: string;
  title: string;
}

const MONTHS: [RegExp, number][] = [
  [/январ/i, 0], [/феврал/i, 1], [/март/i, 2], [/апрел/i, 3],
  [/ма[йя]|мае/i, 4], [/июн/i, 5], [/июл/i, 6], [/август/i, 7],
  [/сентябр/i, 8], [/октябр/i, 9], [/ноябр/i, 10], [/декабр/i, 11],
];

const WEEKDAYS: [RegExp, number][] = [
  [/понедельник/i, 1], [/вторник/i, 2], [/сред[ауы]/i, 3], [/четверг/i, 4],
  [/пятниц/i, 5], [/суббот/i, 6], [/воскресень/i, 0],
];

const p2 = (n: number) => String(n).padStart(2, "0");
const isoOf = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

const DAY_NAMES = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

const TODAY: DateRef = { offset: 0, iso: null, label: "сегодня" };

/**
 * Какой день имеется в виду. По умолчанию — сегодня: администратор живёт
 * сегодняшним днём, и «сколько записано» без даты означает именно его.
 */
export function dateFrom(text: string, now: Date): DateRef {
  const q = text.toLowerCase();
  if (/послезавтра/.test(q)) return { offset: 2, iso: null, label: "послезавтра" };
  if (/завтра/.test(q)) return { offset: 1, iso: null, label: "завтра" };
  if (/вчера/.test(q)) return { offset: -1, iso: null, label: "вчера" };

  /** «14 сентября» и «14.09» — точная дата. */
  const named = q.match(/(\d{1,2})\s+([а-яё]{3,})/);
  if (named) {
    const month = MONTHS.find(([re]) => re.test(named[2]))?.[1];
    if (month !== undefined) {
      const day = Number(named[1]);
      if (day >= 1 && day <= 31) {
        // Год не называют: ближайший такой день — этого года, а если он давно
        // прошёл (больше полугода назад), речь о следующем.
        const year =
          new Date(now.getFullYear(), month, day).getTime() < now.getTime() - 183 * 864e5
            ? now.getFullYear() + 1
            : now.getFullYear();
        return {
          offset: null,
          iso: isoOf(new Date(year, month, day)),
          label: `${day} ${DAY_NAMES[month]}`,
        };
      }
    }
  }

  const dotted = q.match(/(?<!\d)(\d{1,2})[.](\d{1,2})(?:[.](\d{2,4}))?(?!\d)/);
  if (dotted) {
    const day = Number(dotted[1]);
    const month = Number(dotted[2]) - 1;
    if (day >= 1 && day <= 31 && month >= 0 && month <= 11) {
      const rawYear = dotted[3] ? Number(dotted[3]) : now.getFullYear();
      const year = rawYear < 100 ? 2000 + rawYear : rawYear;
      return {
        offset: null,
        iso: isoOf(new Date(year, month, day)),
        label: `${day} ${DAY_NAMES[month]}`,
      };
    }
  }

  /** «в пятницу» — ближайшая пятница вперёд, включая сегодня. */
  const weekday = WEEKDAYS.find(([re]) => re.test(q))?.[1];
  if (weekday !== undefined) {
    const ahead = (weekday - now.getDay() + 7) % 7;
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead);
    return { offset: ahead, iso: isoOf(at), label: ahead === 0 ? "сегодня" : `в ${lower(q, weekday)}` };
  }

  return TODAY;
}

/** Название дня недели в том падеже, в котором его написал человек. */
function lower(q: string, weekday: number): string {
  const found = WEEKDAYS.find(([, index]) => index === weekday);
  const m = found ? q.match(new RegExp(`${found[0].source}\\p{L}*`, "iu")) : null;
  return m ? m[0] : "этот день";
}

/**
 * Врач, названный в вопросе. Ищем по первым буквам каждого слова имени, чтобы
 * падежи не мешали: «к Ирине Алилгаджиевне» — это «Ирина Алилгаджиевна».
 *
 * Совпало несколько — не угадываем: у клиники две Ирины, и отправить список
 * пациентов не того врача хуже, чем переспросить.
 */
export function staffIn(text: string, staff: KnownStaff[]): { one: KnownStaff | null; many: KnownStaff[] } {
  const norm = text.toLowerCase().replace(/ё/g, "е");
  /**
   * Сравниваем по корню в четыре буквы: администратор пишет в падеже — «у
   * Ирины», «к Ирине», «Омаровой». Пять букв («ирина») не совпадали ни с
   * одной из этих форм, и врач в вопросе просто не находился.
   */
  const scored = staff
    .map((s) => ({
      staff: s,
      score: s.name
        .toLowerCase()
        .replace(/ё/g, "е")
        .split(/\s+/)
        .filter((w) => w.length >= 4)
        .filter((w) => norm.includes(w.slice(0, Math.min(6, Math.max(4, w.length - 2)))))
        .length,
    }))
    .filter((x) => x.score > 0);
  if (scored.length === 0) return { one: null, many: [] };

  /**
   * Совпало несколько — берём того, у кого совпало БОЛЬШЕ слов имени.
   *
   * «Ирина Алилгаджиевна» совпадает и с Ириной Омаровой — по имени, — но у
   * первой совпали два слова из двух названных. А вот просто «Ирина» совпадает
   * с обеими одинаково: тут не угадываем и переспрашиваем, потому что
   * отправить список пациентов не того врача хуже, чем задать вопрос.
   */
  const best = Math.max(...scored.map((x) => x.score));
  const top = scored.filter((x) => x.score === best).map((x) => x.staff);
  return { one: top.length === 1 ? top[0] : null, many: top };
}

/** Слова, которые в подборе услуги только мешают: они есть в любом вопросе. */
const SERVICE_NOISE =
  /(?:сколько|скольким|запис\p{L}*|пациент\p{L}*|человек\p{L}*|сегодня|завтра|вчера|сумм\p{L}*|денег|приём|прием|приёмов|приемов|осталось|отправ\p{L}*|напиш\p{L}*|всем|кто|что|когда|как|у|к|на|в|за|по|и)/giu;

export function serviceIn(text: string, services: KnownService[]): KnownService | null {
  const cleaned = text.toLowerCase().replace(/ё/g, "е").replace(SERVICE_NOISE, " ");
  const words = cleaned.split(/[^а-яa-z0-9-]+/).filter((w) => w.length >= 4);
  if (words.length === 0) return null;
  let best: { service: KnownService; score: number } | null = null;
  for (const s of services) {
    const title = s.title.toLowerCase().replace(/ё/g, "е");
    for (const w of words) {
      const stem = w.slice(0, Math.max(4, w.length - 2));
      if (!title.includes(stem)) continue;
      const score = stem.length;
      if (!best || score > best.score) best = { service: s, score };
    }
  }
  return best?.service ?? null;
}

/** Текст рассылки: всё после двоеточия или кавычек — это слова для пациента. */
export function broadcastText(question: string): string {
  const quoted = question.match(/[«"]([^»"]{5,})[»"]/);
  if (quoted) return quoted[1].trim();
  const colon = question.indexOf(":");
  if (colon >= 0 && question.length - colon > 6) return question.slice(colon + 1).trim();
  return "";
}

const ASKS_BROADCAST =
  /(?:отправ\p{L}*|напиш\p{L}*|разошл\p{L}*|рассыл\p{L}*|сообщ\p{L}*|предупред\p{L}*|оповест\p{L}*)/iu;

/**
 * Разобрать вопрос.
 *
 * Порядок проверок — от самого определённого к общему: сначала действие (оно
 * дороже всего ошибочного разбора), потом расчёты, потом вопрос про пациента.
 */
export function parseAdminQuestion(
  question: string,
  known: { staff: KnownStaff[]; services: KnownService[] },
  now: Date = new Date(),
): AdminIntent {
  const q = question.trim();
  if (!q) return { kind: "unknown" };
  const low = q.toLowerCase().replace(/ё/g, "е");

  if (/что\s+(?:ты\s+)?(?:умеешь|можешь)|помощь|справка|команд/.test(low)) return { kind: "help" };

  const date = dateFrom(low, now);
  const staff = staffIn(q, known.staff);
  const service = serviceIn(q, known.services);

  /**
   * Рассылка. Требуем и просьбу отправить, и указание, кому: «отправь всем
   * записанным к Ирине сегодня». Без адресата рассылки не бывает — это уже
   * просто сообщение, и его отправляют из переписки.
   */
  if (ASKS_BROADCAST.test(low) && /(?:всем|запис\p{L}*|пациент\p{L}*)/iu.test(low)) {
    return {
      kind: "broadcast",
      date,
      staffId: staff.one?.id ?? null,
      serviceId: service?.id ?? null,
      text: broadcastText(q),
    };
  }

  // Текст уже без «ё»: «ждёт» здесь выглядит как «ждет», поэтому корень «жд».
  if (/жд\p{L}*\s+ответа|неотвеч|кому\s+не\s+ответили|кто\s+пишет/u.test(low)) {
    return { kind: "waiting" };
  }

  if (/кому\s+(?:позвонить|звонить)|обзвон|кого\s+позвать|очеред[ьи]\s+звонков/.test(low)) {
    return { kind: "callbacks" };
  }

  if (/новы[хе]\s+пациент|сколько\s+новых/.test(low)) {
    return { kind: "new_patients", date };
  }

  if (/кто\s+сейчас|сейчас\s+на\s+при[её]ме|кто\s+следующ|следующий\s+пациент/.test(low)) {
    return { kind: "now", staffId: staff.one?.id ?? null };
  }

  if (/окн[оа]|окошк|свободн/.test(low)) {
    return { kind: "free_slots", date, staffId: staff.one?.id ?? null };
  }

  if (/не\s+приш|неявк|не\s+отмеч|без\s+отметки|разобранност/.test(low)) {
    return { kind: "attendance", date };
  }

  if (/сколько\s+(?:ещ[её]|осталось)|ещ[её]\s+принять|осталось\s+принять|кто\s+ещ[её]/.test(low)) {
    return { kind: "remaining", date, staffId: staff.one?.id ?? null };
  }

  if (/на\s+какую\s+сумму|сколько\s+денег|выручк|сумма\s+за/.test(low)) {
    return { kind: "day_money", date, staffId: staff.one?.id ?? null };
  }

  if (/^кто\s+запис|список\s+запис|покажи\s+запис|кто\s+идет|кто\s+ид[её]т|распис/.test(low)) {
    return {
      kind: "schedule",
      date,
      staffId: staff.one?.id ?? null,
      serviceId: service?.id ?? null,
    };
  }

  if (/сколько\s+(?:пациент\p{L}*|человек|запис\p{L}*|при[её]м\p{L}*)|скольких/iu.test(low)) {
    return {
      kind: "day_load",
      date,
      staffId: staff.one?.id ?? null,
      serviceId: service?.id ?? null,
    };
  }

  /**
   * Вопрос про конкретного пациента: в нём есть имя с большой буквы, которого
   * нет среди врачей. Имя разбирает уже сервер — здесь только признак.
   */
  const patient = personName(q, known.staff);
  if (patient) return { kind: "patient", name: patient, question: q };

  return { kind: "unknown" };
}

/**
 * Имя пациента в вопросе.
 *
 * Берём слова с большой буквы, выкидывая начало предложения и имена врачей:
 * «Сколько должна Магомедова?» — это Магомедова. Флаг `i` рядом с `\p{Lu}`
 * складывает регистры, поэтому регистр проверяем без него.
 */
function personName(question: string, staff: KnownStaff[]): string | null {
  const words = question.split(/[\s,.!?]+/).filter(Boolean);
  const staffWords = new Set(
    staff.flatMap((s) => s.name.toLowerCase().replace(/ё/g, "е").split(/\s+/)),
  );
  const names = words
    .slice(1)
    .filter((w) => /^\p{Lu}\p{Ll}{2,}$/u.test(w))
    .filter((w) => !staffWords.has(w.toLowerCase().replace(/ё/g, "е")));
  return names.length > 0 ? names.join(" ") : null;
}

/**
 * Получатель рассылки — как его видит администратор перед отправкой.
 *
 * Типы и список возможностей живут в ЧИСТОМ модуле, без обращения к базе:
 * их читает и экран чата, а он клиентский. Утащив их из серверного модуля,
 * сборка тянула бы в браузер Prisma целиком.
 */
export interface BroadcastTarget {
  patientId: string;
  name: string;
  /** «14:30 · Остеопатия, Ирина Алилгаджиевна» — чтобы узнать человека. */
  when: string;
  /** Почему сообщение не уйдёт: нет номера, Instagram, тренировочная переписка. */
  blocked: string | null;
}

export interface BroadcastPlan {
  /** Что именно уйдёт пациенту — дословно. */
  text: string;
  targets: BroadcastTarget[];
  /** Условия рассылки: по ним список пересчитывается при подтверждении. */
  dayIso: string;
  staffId: string | null;
  serviceId: string | null;
  staffName: string | null;
  dateLabel: string;
}

export interface AdminAnswer {
  text: string;
  /** Рассылка ждёт подтверждения: экран показывает список и две кнопки. */
  plan?: BroadcastPlan;
}

/** Что умеет ассистент — один список на все случаи: справка и «не понял». */
export const ADMIN_ABILITIES = [
  "сколько записано сегодня/завтра, у врача и на услугу",
  "на какую сумму записаны и сколько уже принято",
  "сколько ещё осталось принять и кто это",
  "кто сейчас на приёме и кто следующий",
  "свободные окна на день",
  "кто не пришёл и какие приёмы остались без отметки",
  "поимённый список записанных на день",
  "кто ждёт ответа в переписке",
  "кому позвонить — та же очередь, что на экране",
  "сколько новых пациентов за день",
  "справка по пациенту: долг, последний визит, курс, ближайшая запись",
  "рассылка записанным: «отправь всем, кто записан сегодня к Ирине: текст» — с подтверждением",
];
