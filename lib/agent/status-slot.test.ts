import { describe, expect, it } from "vitest";
import {
  candidateDays,
  clinicMoment,
  daySpecIn,
  forSomeoneElse,
  looksLikeOffer,
  parseStatusOffer,
  slotWhen,
  staffPhrase,
  pickIn,
  slotCandidates,
  timesIn,
  wantsSlot,
} from "./status-slot";

/** Врачи клиники — с фамилиями, как в справочнике: иначе двух Ирин не различить. */
const STAFF = [
  { id: "irina-a", name: "Алункачева Ирина Алилгаджиевна" },
  { id: "raziyat", name: "Мугадова Разият Ризвановна" },
  { id: "irina-o", name: "Омарова Ирина" },
];

const TZ = "Europe/Moscow";
/** Момент по Москве. */
const msk = (iso: string) => new Date(`${iso}+03:00`);

describe("разбор статуса", () => {
  it("настоящий статус клиники читается целиком", () => {
    const offer = parseStatusOffer("Окошко на завтра к Ирине Алилгаджиевне ✅ 09:40 (детский)", STAFF);
    expect(offer).not.toBeNull();
    expect(offer!.staff?.id).toBe("irina-a");
    expect(offer!.staffAmbiguous).toBe(false);
    expect(offer!.times).toEqual([9 * 60 + 40]);
    expect(offer!.day).toEqual({ kind: "relative", offset: 1 });
    expect(offer!.audience).toBe("child");
  });

  it("«к Ирине» при двух Иринах врача не назначает", () => {
    const offer = parseStatusOffer("Окошко на завтра к Ирине ✅ 12:15", STAFF);
    expect(offer!.staff).toBeNull();
    expect(offer!.staffAmbiguous).toBe(true);
  });

  it("два врача в одном статусе — какое время чьё, неизвестно", () => {
    for (const text of [
      "Окошки на завтра: 10:00 к Ирине Алилгаджиевне, 15:00 к Разият Ризвановне",
      "Окошки на завтра: 10:00 к Ирине Алилгаджиевне, 15:00 к Разият",
    ]) {
      const offer = parseStatusOffer(text, STAFF);
      expect(offer!.staff, text).toBeNull();
      expect(offer!.staffAmbiguous, text).toBe(true);
    }
  });

  it("название клиники — не врач", () => {
    const offer = parseStatusOffer("Клиника Алункачевой: свободное окошко на завтра 12:15", STAFF);
    expect(offer!.staff).toBeNull();
    expect(offer!.staffAmbiguous).toBe(false);
  });

  it("фамилия врача без слова «клиника» — врач", () => {
    const offer = parseStatusOffer("Окошко к Алункачевой на сегодня 16:00", STAFF);
    expect(offer!.staff?.id).toBe("irina-a");
  });

  it("напоминание о записи и наши собственные ответы окошком не считаются", () => {
    for (const text of [
      "Вы записаны на услугу Детский прием до 10 л - остеопатия к специалисту Ирина Алилгаджиевна на 8 сентября 2026 в 09:00.",
      "Окошко на вт, 30 сентября в 12:15 к Ирине Алилгаджиевне уже заняли.",
      "Окошко на вт, 30 сентября в 12:15 закрепили за вами.",
      "Первичный приём включает беседу и сбор анамнеза.",
    ]) {
      expect(parseStatusOffer(text, STAFF), text).toBeNull();
    }
  });

  it("без времени — не окошко", () => {
    expect(parseStatusOffer("Есть свободные окошки на завтра, пишите!", STAFF)).toBeNull();
  });
});

describe("время в статусе", () => {
  it("несколько окошек", () => {
    expect(timesIn("Окошки на завтра: 09:40, 12:15 и 16:30")).toEqual([580, 735, 990]);
  });

  it("промежуток — одно окошко", () => {
    expect(timesIn("Окошко 12:15–13:00")).toEqual([735]);
    expect(timesIn("Окошко с 12:15 до 13:00")).toEqual([735]);
  });

  it("время через точку не берём: «12.09» — это и дата", () => {
    expect(timesIn("Окошко на 12.15")).toEqual([]);
  });
});

describe("день в статусе", () => {
  it("дата, день недели, относительный день", () => {
    expect(daySpecIn("Окошко 30.09 в 12:15")).toEqual({ kind: "date", day: 30, month: 9 });
    expect(daySpecIn("Окошко 30 сентября в 12:15")).toEqual({ kind: "date", day: 30, month: 9 });
    expect(daySpecIn("Окошко в четверг 12:15")).toEqual({ kind: "weekday", weekday: 4 });
    expect(daySpecIn("Окошко пт 12:15")).toEqual({ kind: "weekday", weekday: 5 });
    expect(daySpecIn("Окошко на послезавтра 12:15")).toEqual({ kind: "relative", offset: 2 });
    expect(daySpecIn("Окошко на сегодня 12:15")).toEqual({ kind: "relative", offset: 0 });
  });

  it("два разных дня недели — день не определён", () => {
    expect(daySpecIn("Окошки в среду и четверг 12:15")).toBeNull();
  });
});

describe("на какой день окошко", () => {
  it("«на завтра» при известном времени публикации — ровно один день", () => {
    const got = candidateDays(
      { kind: "relative", offset: 1 },
      { postedAt: msk("2026-09-29T21:00:00"), now: msk("2026-09-30T08:00:00") },
      TZ,
    );
    // Выложен вечером 29-го — значит завтра это 30-е, хотя читают его уже 30-го.
    expect(got).toEqual({ keys: ["2026-09-30"], certain: true });
  });

  it("«на завтра» без времени публикации — два дня, и мы не угадываем", () => {
    const got = candidateDays({ kind: "relative", offset: 1 }, { postedAt: null, now: msk("2026-09-30T08:00:00") }, TZ);
    expect(got.certain).toBe(false);
    expect(got.keys).toEqual(["2026-09-30", "2026-10-01"]);
  });

  it("день недели — ближайший, начиная с публикации", () => {
    // 29 сентября 2026 — вторник.
    const got = candidateDays({ kind: "weekday", weekday: 4 }, { postedAt: null, now: msk("2026-09-29T10:00:00") }, TZ);
    expect(got).toEqual({ keys: ["2026-10-01"], certain: true });
  });

  it("дата — этого года, а в декабре про январь — следующего", () => {
    expect(
      candidateDays({ kind: "date", day: 30, month: 9 }, { postedAt: null, now: msk("2026-09-29T10:00:00") }, TZ).keys,
    ).toEqual(["2026-09-30"]);
    expect(
      candidateDays({ kind: "date", day: 5, month: 1 }, { postedAt: null, now: msk("2026-12-28T10:00:00") }, TZ).keys,
    ).toEqual(["2027-01-05"]);
  });

  it("несуществующая дата не превращается в соседнюю", () => {
    expect(
      candidateDays({ kind: "date", day: 31, month: 9 }, { postedAt: null, now: msk("2026-09-29T10:00:00") }, TZ).keys,
    ).toEqual([]);
  });

  it("день не назван, выложено вечером — 12:15 это завтра", () => {
    const ref = { postedAt: msk("2026-09-29T20:00:00"), now: msk("2026-09-29T20:30:00") };
    const { keys } = candidateDays(null, ref, TZ);
    const { future } = slotCandidates(keys, [735], ref, TZ, true);
    expect(future.map((c) => c.key)).toEqual(["2026-09-30"]);
  });

  it("день назван, а время к публикации уже прошло — это «прошло», а не завтра", () => {
    const ref = { postedAt: msk("2026-09-29T13:00:00"), now: msk("2026-09-29T13:10:00") };
    const { keys } = candidateDays({ kind: "relative", offset: 0 }, ref, TZ);
    const got = slotCandidates(keys, [735], ref, TZ, false);
    expect(got.future).toEqual([]);
    expect(got.past.map((c) => c.key)).toEqual(["2026-09-29"]);
  });

  it("момент считается в поясе клиники", () => {
    expect(clinicMoment("2026-09-30", 735, TZ).toISOString()).toBe("2026-09-30T09:15:00.000Z");
  });
});

describe("слова пациента в ответ на статус", () => {
  it("просьба взять окошко", () => {
    for (const t of ["Хочу", "+", "Можно?", "Свободно ещё?", "Запишите меня", "Да, давайте", "На 12:15 можно", "👍"]) {
      expect(wantsSlot(t), t).toBe(true);
    }
  });

  it("отказ и вежливость — не просьба", () => {
    for (const t of ["Не надо, спасибо", "Спасибо", "Уже не актуально", "Передумала"]) {
      expect(wantsSlot(t), t).toBe(false);
    }
  });

  it("записывают другого человека", () => {
    for (const t of [
      "Запишите сына",
      "Хочу записать ребёнка",
      "Для мамы можно?",
      "Запишите Амину",
      "Запишите её пожалуйста",
      "Племянника моего запишите",
    ]) {
      expect(forSomeoneElse(t), t).toBe(true);
    }
  });

  it("себя — не другого", () => {
    for (const t of ["Запишите пожалуйста", "Запишите, Пожалуйста", "Хочу на другое время", "Можно мне?", "Хочу"]) {
      expect(forSomeoneElse(t), t).toBe(false);
    }
  });
});

describe("выбор среди вариантов", () => {
  const now = msk("2026-09-29T10:00:00");

  it("день — относительно ответа пациента", () => {
    expect(pickIn("завтра", now, TZ).keys).toEqual(["2026-09-30"]);
    expect(pickIn("сегодня", now, TZ).keys).toEqual(["2026-09-29"]);
    expect(pickIn("в четверг", now, TZ).keys).toEqual(["2026-10-01"]);
    expect(pickIn("30.09", now, TZ).keys).toEqual(["2026-09-30"]);
  });

  it("время — полное и одним часом", () => {
    expect(pickIn("на 12:15", now, TZ).minutes).toEqual([735]);
    expect(pickIn("в 12", now, TZ).hours).toEqual([12]);
  });

  it("да и нет", () => {
    expect(pickIn("Да", now, TZ).yes).toBe(true);
    expect(pickIn("верно", now, TZ).yes).toBe(true);
    expect(pickIn("Нет", now, TZ).no).toBe(true);
    expect(pickIn("нет, не то", now, TZ).no).toBe(true);
    expect(pickIn("Хочу на 15:00", now, TZ).yes).toBe(false);
  });
});

describe("как агент называет окошко", () => {
  it("дата — так же, как в ответе «когда у меня запись»", () => {
    expect(slotWhen(msk("2026-09-30T12:15:00"))).toBe("ср, 30 сентября в 12:15");
  });

  it("врач — словами самой клиники из статуса", () => {
    const irina = STAFF[0];
    expect(staffPhrase("Окошко на завтра к Ирине Алилгаджиевне ✅ 09:40", irina)).toBe("к Ирине Алилгаджиевне");
    expect(staffPhrase("Окошко к Алункачевой на сегодня 16:00", irina)).toBe("к Алункачевой");
  });

  it("нет такого оборота — имя как в справочнике, без склонения кодом", () => {
    expect(staffPhrase("Ирина Алилгаджиевна: окошко 12:15", STAFF[0])).toBe("(Алункачева Ирина Алилгаджиевна)");
  });

  it("оборот про другого врача не подставляется", () => {
    // «к Разият» — не Ирина, даже если статус разобран как Иринин.
    expect(staffPhrase("к Разият Ризвановне, окошко 12:15", STAFF[0])).toBe("(Алункачева Ирина Алилгаджиевна)");
  });

  it("похоже ли на окошко — без справочника врачей", () => {
    expect(looksLikeOffer("Окошко на завтра к Ирине ✅ 09:40")).toBe(true);
    expect(looksLikeOffer("Вы записаны на 8 сентября в 09:00")).toBe(false);
    expect(looksLikeOffer("Есть окошки, пишите")).toBe(false);
    expect(looksLikeOffer(null)).toBe(false);
  });
});
