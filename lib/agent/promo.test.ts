import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SCHOOL_QUESTION,
  ageOutside,
  askedSchool,
  matchSchool,
  promoTriggered,
  promoVisible,
  shouldAskSchool,
  statedChildAges,
  visiblePromos,
  type PromoForAgent,
} from "./promo";
import { usableKnowledgeWhere } from "./knowledge";

const now = new Date("2026-10-20T10:00:00Z");
const promo: PromoForAgent<{ id: string }> = {
  id: "p1",
  isActive: true,
  agentEnabled: true,
  startsAt: new Date("2026-10-01T00:00:00Z"),
  endsAt: new Date("2026-11-15T20:59:59Z"),
  ageMin: 6,
  ageMax: 14,
  entries: [{ id: "k1" }],
};

/**
 * Тесты на утечку — обязательные (ТЗ 4A.7). Промпт агента будет меняться, и
 * регресс поймается только здесь: акция не должна всплывать там, где о ней не
 * спрашивали.
 */
describe("утечка: акция НЕ появляется", () => {
  it.each([
    "сколько стоит приём остеопата",
    "Сколько стоит приём остеопата для взрослого?",
    "хочу записаться на капельницу",
    "какие часы работы",
    "А БОС-терапия сыну 9 лет сколько стоит?",
    "Хочу записать дочку к остеопату",
    "можно перенести запись на пятницу?",
    "сколько стоят анализы?",
    "нейромедитация есть?",
    "Ребёнок пошёл в школу, болит спина",
    "хочу обследовать ребёнка 3 лет",
    "реакция на капельницу нормальная?",
  ])("«%s»", (text) => {
    expect(promoTriggered(text, promo)).toBe(false);
    expect(visiblePromos([promo], [text], now)).toEqual([]);
  });

  it("любой разговор после конца акции", () => {
    const after = new Date("2026-11-16T10:00:00Z");
    expect(visiblePromos([promo], ["что за школьный чек-ап?"], after)).toEqual([]);
  });

  it("до начала акции", () => {
    expect(visiblePromos([promo], ["что за школьный чек-ап?"], new Date("2026-09-20T10:00:00Z"))).toEqual([]);
  });

  it("при agentEnabled = false", () => {
    expect(visiblePromos([{ ...promo, agentEnabled: false }], ["что за школьный чек-ап?"], now)).toEqual([]);
  });

  it("при выключенной акции", () => {
    expect(visiblePromos([{ ...promo, isActive: false }], ["видела акцию для школьников"], now)).toEqual([]);
  });

  it("без записи справочника — агенту знать неоткуда", () => {
    expect(visiblePromos([{ ...promo, entries: [] }], ["что за школьный чек-ап?"], now)).toEqual([]);
  });

  it("пациент уже привязан — про школу второй раз не спрашивает", () => {
    expect(shouldAskSchool({ agentTexts: [], attributed: true, schools: 3 })).toBe(false);
  });

  it("уже спрашивали в этой переписке — не спрашивает снова", () => {
    expect(shouldAskSchool({ agentTexts: [`Акция действует до 15 ноября. ${SCHOOL_QUESTION}`], attributed: false, schools: 3 })).toBe(false);
  });

  it("записи акции никогда не входят в общий справочник агента", () => {
    expect(usableKnowledgeWhere("c1")).toMatchObject({ promoId: null });
  });

  it("текст акции не зашит в промпт агента", () => {
    const src = ["lib/agent/llm.ts", "lib/agent/clinic-agent.ts"].map((f) => readFileSync(f, "utf8")).join("\n");
    expect(src).not.toMatch(/6\s?300\s?₽|9\s?360|ферритин|Школьный check-up/i);
  });
});

describe("акция появляется", () => {
  it.each(["что за школьный чек-ап?", "видела акцию для школьников", "хочу обследовать ребёнка 9 лет", "Здравствуйте, расскажите про check-up", "Чекап для сына ещё действует?"])(
    "«%s»",
    (text) => {
      expect(promoTriggered(text, promo)).toBe(true);
      expect(visiblePromos([promo], [text], now).map((p) => p.id)).toEqual(["p1"]);
    },
  );

  it("уточнение после вопроса об акции — всё ещё про акцию", () => {
    expect(visiblePromos([promo], ["а сколько длится?", "что за школьный чек-ап?"], now)).toHaveLength(1);
  });

  it("спрашивает про школу, пока не спрашивал и пациент не привязан", () => {
    expect(shouldAskSchool({ agentTexts: ["Здравствуйте!"], attributed: false, schools: 2 })).toBe(true);
    expect(shouldAskSchool({ agentTexts: [], attributed: false, schools: 0 })).toBe(false);
    expect(askedSchool([SCHOOL_QUESTION])).toBe(true);
  });
});

describe("возраст 6–14", () => {
  it("возраст ребёнка, а не родителя", () => {
    expect(statedChildAges(["Мне 34 года, сыну 9 лет"])).toEqual([9]);
    expect(statedChildAges(["дочке 4 года и 2 месяца"])).toEqual([4, 0]);
    expect(statedChildAges(["ребёнку 8 мес"])).toEqual([0]);
    expect(statedChildAges(["Есть акция для ребёнка 4 лет?"])).toEqual([4]);
    expect(statedChildAges(["мне уже 40 лет"])).toEqual([]);
  });

  it("вне границ — передаём человеку", () => {
    expect(ageOutside([4], promo)).toBe(true);
    expect(ageOutside([15], promo)).toBe(true);
    expect(ageOutside([6, 14], promo)).toBe(false);
    expect(ageOutside([], promo)).toBe(false);
  });
});

describe("ответ про школу", () => {
  const schools = [
    { id: "s1", name: "Школа подготовки «Росток»" },
    { id: "s2", name: "Центр развития «Маленький гений»" },
    { id: "s3", name: "Школа № 5" },
    { id: "s4", name: "Росток-2" },
  ];

  it("однозначное совпадение — с падежом", () => {
    expect(matchSchool("Да, из Маленького гения", schools)).toEqual({ kind: "match", schoolId: "s2" });
    expect(matchSchool("от школы 5", schools)).toEqual({ kind: "match", schoolId: "s3" });
  });

  it("«Росток» и «Росток-2» — номер решает", () => {
    expect(matchSchool("из Ростка", schools)).toEqual({ kind: "match", schoolId: "s1" });
  });

  it("две подходящие — не выбирает сам", () => {
    const twins = [...schools, { id: "s5", name: "Детский центр «Росток»" }];
    expect(matchSchool("из Ростка", twins)).toEqual({ kind: "ambiguous", schoolIds: ["s1", "s5"] });
  });

  it("похожую школу не берёт", () => {
    expect(matchSchool("из школы 15", schools)).toEqual({ kind: "unknown" });
    expect(matchSchool("из гения", schools)).toEqual({ kind: "unknown" });
  });

  it("отказ — не эскалация", () => {
    for (const a of ["Нет", "нет, сами нашли", "из инстаграма", "Подруга посоветовала", "Не помню"]) {
      expect(matchSchool(a, schools).kind).toBe("declined");
    }
  });

  it("невнятно — школа не определена", () => {
    expect(matchSchool("Да", schools)).toEqual({ kind: "unknown" });
    expect(matchSchool("из той что на Ленина", schools)).toEqual({ kind: "unknown" });
  });
});

describe("видимость акции", () => {
  it("граница — включительно до конца", () => {
    expect(promoVisible(promo, promo.endsAt)).toBe(true);
    expect(promoVisible(promo, new Date(promo.endsAt.getTime() + 1))).toBe(false);
  });
});
