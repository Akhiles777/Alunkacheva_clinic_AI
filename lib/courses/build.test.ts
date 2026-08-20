import { describe, expect, it } from "vitest";
import {
  assignSales,
  buildCourses,
  looksLikeCourseSale,
  priceMatches,
  pricePerSession,
  recentSessionPrice,
  type CourseVisit,
} from "./build";

const day = (d: number): Date => new Date(`2026-08-${String(d).padStart(2, "0")}T09:00:00+03:00`);
const visit = (id: string, d: number, revenue = 0): CourseVisit => ({ id, startAt: day(d), revenue });
/** Живые числа клиники: сеанс БОС 2 800 ₽, курс из десяти — 28 000 ₽ по плану. */
const BOS = { planPrice: 28000, sessionsTotal: 10 };
/** «18 августа» в тестах — тот же день, что и в живых данных клиники. */

describe("похожа ли оплата на продажу курса", () => {
  it("цена одного сеанса — это платный приём, а не курс", () => {
    expect(looksLikeCourseSale(2800, 28000)).toBe(false);
  });

  it("двадцать пять тысяч при курсе в 28 000 — продажа курса", () => {
    // Курс продают со скидкой, поэтому хватает половины плановой цены.
    expect(looksLikeCourseSale(25000, 28000)).toBe(true);
  });

  it("тысяча при курсе НАК в 10 000 курсом не станет", () => {
    // Ровно этот случай сломал прошлое правило: сеанс НАК стоит то 500, то
    // 1 000 ₽, оценка цены сеанса упала до пятисот, порог стал 750 — и каждый
    // одиночный платёж открывал курс. В карточке появились три «НАК 1/10».
    expect(looksLikeCourseSale(1000, 10000)).toBe(false);
  });

  it("исторические цены ниже нынешней курсом не становятся", () => {
    expect(looksLikeCourseSale(2500, 28000)).toBe(false);
    expect(looksLikeCourseSale(2300, 28000)).toBe(false);
  });

  it("половина курса — уже курс: продают со скидкой и платят частями", () => {
    expect(looksLikeCourseSale(14000, 28000)).toBe(true);
    expect(looksLikeCourseSale(13999, 28000)).toBe(false);
  });

  it("плановая цена неизвестна — судить не о чем", () => {
    expect(looksLikeCourseSale(25000, 0)).toBe(false);
  });
});

describe("сборка курса из записей", () => {
  it("продажа курса открывает курс, нули к нему прикрепляются", () => {
    const plan = buildCourses(
      [visit("v1", 1, 25000), visit("v2", 3), visit("v3", 5), visit("v4", 7)],
      BOS,
    );
    expect(plan.courses).toHaveLength(1);
    expect(plan.courses[0].amount).toBe(25000);
    // Десять — из справочника клиники, а не из деления 25 000 на 2 800.
    expect(plan.courses[0].sessionsTotal).toBe(10);
    expect(plan.courses[0].purchasedAt).toEqual(day(1));
    expect(plan.courses[0].visitIds).toEqual(["v1", "v2", "v3", "v4"]);
  });

  it("оплата одного сеанса курса не открывает", () => {
    // Ровно это и рисовало на экране «БОС-терапия 1/2»: семьдесят два платежа
    // по цене сеанса превращались в семьдесят два крошечных «курса».
    const plan = buildCourses([visit("v1", 1, 2800), visit("v2", 3)], BOS);
    expect(plan.courses).toEqual([]);
    expect(plan.orphans).toEqual(["v2"]);
  });

  it("платный приём внутри курса курс не рвёт", () => {
    const plan = buildCourses(
      [visit("v1", 1, 25000), visit("v2", 3), visit("v3", 4, 2800), visit("v4", 5)],
      BOS,
    );
    expect(plan.courses).toHaveLength(1);
    expect(plan.courses[0].visitIds).toEqual(["v1", "v2", "v4"]);
  });

  it("день продажи — это день оплаты, а не день последнего сеанса", () => {
    const plan = buildCourses([visit("v1", 1, 25000), visit("v2", 20)], BOS);
    expect(plan.courses[0].purchasedAt).toEqual(day(1));
  });

  it("вторая продажа открывает второй курс", () => {
    const plan = buildCourses(
      [visit("v1", 1, 25000), visit("v2", 3), visit("v3", 10, 25000), visit("v4", 12)],
      BOS,
    );
    expect(plan.courses).toHaveLength(2);
    expect(plan.courses[1].visitIds).toEqual(["v3", "v4"]);
  });

  it("сеансов больше проданного — лишние не приписываем", () => {
    const plan = buildCourses(
      [visit("v1", 1, 25000), visit("v2", 2), visit("v3", 3)],
      { planPrice: 5600, sessionsTotal: 2 },
    );
    expect(plan.courses[0].visitIds).toEqual(["v1", "v2"]);
    expect(plan.orphans).toEqual(["v3"]);
  });

  it("сеансы без продажи в данных — курс куплен абонементом", () => {
    // Именно этот случай у клиники массовый: семь сеансов подряд без единой
    // оплаты в записях. Придумывать им курс нельзя.
    const plan = buildCourses([visit("v1", 1), visit("v2", 3)], BOS);
    expect(plan.courses).toEqual([]);
    expect(plan.orphans).toEqual(["v1", "v2"]);
  });

  it("цена сеанса неизвестна — курсов не собираем вовсе", () => {
    const plan = buildCourses([visit("v1", 1, 25000), visit("v2", 3)], {
      planPrice: 0,
      sessionsTotal: 10,
    });
    expect(plan.courses).toEqual([]);
  });

  it("порядок визитов восстанавливается сам", () => {
    const plan = buildCourses([visit("v2", 5), visit("v1", 1, 25000)], BOS);
    expect(plan.courses[0].visitIds).toEqual(["v1", "v2"]);
  });

  it("пусто на входе — пусто на выходе", () => {
    expect(buildCourses([], BOS)).toEqual({ courses: [], orphans: [] });
  });
});

describe("цена сеанса", () => {
  it("ровное деление", () => {
    expect(pricePerSession(28000, 10)).toBe(2800);
  });

  it("неровное деление округляется до копейки", () => {
    expect(pricePerSession(10000, 3)).toBe(3333.33);
  });

  it("нулевое число сеансов не роняет расчёт", () => {
    expect(pricePerSession(5000, 0)).toBe(5000);
  });
});

describe("курс открывает продажа из кассы", () => {
  const sale = (id: string, d: number, amount = 28000) => ({ id, at: day(d), amount });

  it("продажа 17 августа подбирает сеансы, начавшиеся следом", () => {
    // Ровно случай клиники: в записях оплаты БОС нет ни одной, а в кассе
    // 13 000 + 15 000 одной покупкой — и сеансы со следующего дня.
    const plan = buildCourses([visit("v1", 18), visit("v2", 19), visit("v3", 20)], {
      ...BOS,
      sales: [sale("s1", 17)],
    });
    expect(plan.courses).toHaveLength(1);
    expect(plan.courses[0].amount).toBe(28000);
    expect(plan.courses[0].purchasedAt).toEqual(day(17));
    expect(plan.courses[0].visitIds).toEqual(["v1", "v2", "v3"]);
    expect(plan.orphans).toEqual([]);
  });

  it("сеанс до продажи к ней не приписывается", () => {
    const plan = buildCourses([visit("v0", 10), visit("v1", 18)], { ...BOS, sales: [sale("s1", 17)] });
    expect(plan.orphans).toEqual(["v0"]);
    expect(plan.courses[0].visitIds).toEqual(["v1"]);
  });

  it("одна продажа открывает один курс, а не каждый сеанс", () => {
    const plan = buildCourses(
      [visit("v1", 18), visit("v2", 19)],
      { ...BOS, sessionsTotal: 1, sales: [sale("s1", 17)] },
    );
    expect(plan.courses).toHaveLength(1);
    expect(plan.orphans).toEqual(["v2"]);
  });

  it("вторая продажа открывает второй курс, когда первый израсходован", () => {
    const plan = buildCourses(
      [visit("v1", 18), visit("v2", 19), visit("v3", 25)],
      { ...BOS, sessionsTotal: 2, sales: [sale("s1", 17), sale("s2", 24)] },
    );
    expect(plan.courses).toHaveLength(2);
    expect(plan.courses[1].purchasedAt).toEqual(day(24));
    expect(plan.courses[1].visitIds).toEqual(["v3"]);
  });

  it("мелкая покупка курсом не считается", () => {
    // 2 800 ₽ — цена одного сеанса; в кассе так оплачивают разовый приём.
    const plan = buildCourses([visit("v1", 18)], { ...BOS, sales: [sale("s1", 17, 2800)] });
    expect(plan.courses).toEqual([]);
    expect(plan.orphans).toEqual(["v1"]);
  });
});

describe("кому принадлежит продажа", () => {
  const sale = (id: string, d: number, amount = 28000) => ({ id, at: day(d), amount });
  /** Курс БОС: сеанс 2 800 ₽, десять сеансов — плановая цена 28 000 ₽. */
  const bos = (dates: number[]) => ({ dates: dates.map(day), planPrice: 28000 });
  /** Курс НАК: сеанс 1 000 ₽, десять сеансов — 10 000 ₽. */
  const nak = (dates: number[]) => ({ dates: dates.map(day), planPrice: 10000 });

  it("кандидат один — привязываем", () => {
    const out = assignSales([sale("s1", 17)], new Map([["bos", bos([18, 19])]]));
    expect(out.byService.get("bos")).toHaveLength(1);
    expect(out.ambiguous).toEqual([]);
  });

  it("сумма покупки решает, какой это курс", () => {
    // Пациент купил оба курса и ходит на оба. Раньше это давало ноль курсов:
    // кандидатов двое — значит не разбираем. Но 28 000 ₽ ни при каких
    // условиях не курс НАК по 1 000 ₽ за сеанс.
    const out = assignSales(
      [sale("s1", 17, 28000), sale("s2", 17, 10000)],
      new Map([
        ["bos", bos([18, 20])],
        ["nak", nak([18, 21])],
      ]),
    );
    expect(out.byService.get("bos")?.map((x) => x.id)).toEqual(["s1"]);
    expect(out.byService.get("nak")?.map((x) => x.id)).toEqual(["s2"]);
    expect(out.ambiguous).toEqual([]);
  });

  it("скидка на курс привязку не ломает", () => {
    // 25 000 вместо 28 000 — обычное дело.
    const out = assignSales(
      [sale("s1", 17, 25000)],
      new Map([
        ["bos", bos([18])],
        ["nak", nak([18])],
      ]),
    );
    expect(out.byService.get("bos")).toHaveLength(1);
  });

  it("две услуги с похожей ценой — не гадаем", () => {
    const out = assignSales(
      [sale("s1", 17, 28000)],
      new Map([
        ["bos", bos([18])],
        ["двойник", { dates: [day(18)], planPrice: 27000 }],
      ]),
    );
    expect(out.byService.size).toBe(0);
    expect(out.ambiguous).toHaveLength(1);
  });

  it("сумма не подходит ни одной, а кандидатов двое — не гадаем", () => {
    const out = assignSales(
      [sale("s1", 17, 90000)],
      new Map([
        ["bos", bos([18])],
        ["nak", nak([18])],
      ]),
    );
    expect(out.byService.size).toBe(0);
    expect(out.ambiguous).toHaveLength(1);
  });

  it("плановой цены нет — курса не будет", () => {
    // По услуге не было ни одного платного приёма: сколько стоит её курс,
    // взять неоткуда. Назвать покупку курсом значило бы решить за клинику.
    const out = assignSales(
      [sale("s1", 17)],
      new Map([["bos", { dates: [day(18)], planPrice: 0 }]]),
    );
    expect(out.byService.size).toBe(0);
    expect(out.ambiguous).toEqual([]);
  });

  it("оплата одного сеанса курса не открывает, даже когда услуга одна", () => {
    // Ровно случай НАК-метода: сеанс 1 000 ₽, курс 10 000 ₽. Кандидат
    // единственный, и прошлое правило отдавало ему платёж не глядя на сумму.
    const out = assignSales(
      [sale("s1", 17, 1000)],
      new Map([["nak", { dates: [day(18), day(19)], planPrice: 10000 }]]),
    );
    expect(out.byService.size).toBe(0);
    expect(out.ambiguous).toEqual([]);
  });

  it("сеансов после покупки нет — продажа не про курс", () => {
    // Мог быть куплен товар: молчим, а не считаем это неразобранным.
    const out = assignSales([sale("s1", 17)], new Map([["bos", bos([10])]]));
    expect(out.byService.size).toBe(0);
    expect(out.ambiguous).toEqual([]);
  });

  it("покупка слишком давняя для этих сеансов", () => {
    const out = assignSales([sale("s1", 1)], new Map([["bos", bos([28])]]), 5);
    expect(out.byService.size).toBe(0);
    expect(out.ambiguous).toEqual([]);
  });
});

describe("сумма против плановой цены курса", () => {
  it("совпадение в точку", () => {
    expect(priceMatches(28000, 28000)).toBe(true);
  });

  it("скидка в одиннадцать процентов — то же самое", () => {
    expect(priceMatches(25000, 28000)).toBe(true);
  });

  it("цена одного сеанса курсом не притворится", () => {
    expect(priceMatches(2800, 28000)).toBe(false);
  });

  it("чужой курс не подойдёт", () => {
    expect(priceMatches(10000, 28000)).toBe(false);
  });

  it("плановая цена неизвестна — сравнивать не с чем", () => {
    expect(priceMatches(28000, 0)).toBe(false);
  });
});

describe("цена сеанса по недавним оплатам", () => {
  it("берёт нынешнюю цену, а не позапрошлогоднюю", () => {
    // Свежие оплаты идут первыми: клиника подняла цену с 2 500 до 2 800.
    const amounts = [2800, 2800, 2800, 2800, 2500, 2500, 2500, 2500, 2300, 2300];
    expect(recentSessionPrice(amounts, 4)).toBe(2800);
  });

  it("продажа курса записью цену не сдвигает", () => {
    expect(recentSessionPrice([25000, 2800, 2800, 2800, 2800])).toBe(2800);
  });

  it("две цены поровну — берём большую, а не среднюю", () => {
    // НАК-метод: сеанс стоит то 500, то 1 000 ₽. Медиана падала на пятьсот, и
    // плановая цена курса выходила вдвое ниже настоящей — а по ней отличают
    // покупку курса от оплаты приёма.
    expect(recentSessionPrice([1000, 500, 1000, 500, 1000, 500, 1000, 500])).toBe(1000);
  });

  it("оплат не было — цены нет", () => {
    expect(recentSessionPrice([])).toBe(0);
  });

  it("нули и возвраты в расчёт не идут", () => {
    expect(recentSessionPrice([0, -500, 2800, 2800])).toBe(2800);
  });
});

describe("порядок расходования курсов", () => {
  const sale = (id: string, d: number, amount = 28000) => ({ id, at: day(d), amount });

  it("сначала расходуется тот курс, что куплен раньше", () => {
    // Пациент купил два курса подряд. Раньше бралась последняя продажа, и
    // первый курс висел неиспользованным до конца.
    const plan = buildCourses(
      [visit("v1", 12), visit("v2", 13), visit("v3", 14)],
      { planPrice: 28000, sessionsTotal: 2, sales: [sale("ранний", 10), sale("поздний", 11)] },
    );
    expect(plan.courses).toHaveLength(2);
    expect(plan.courses[0].purchasedAt).toEqual(day(10));
    expect(plan.courses[0].visitIds).toEqual(["v1", "v2"]);
    expect(plan.courses[1].purchasedAt).toEqual(day(11));
    expect(plan.courses[1].visitIds).toEqual(["v3"]);
  });

  it("вторая покупка ждёт, пока первый курс не израсходован", () => {
    const plan = buildCourses([visit("v1", 12)], {
      planPrice: 28000,
      sessionsTotal: 10,
      sales: [sale("s1", 10), sale("s2", 11)],
    });
    expect(plan.courses).toHaveLength(1);
    expect(plan.courses[0].purchasedAt).toEqual(day(10));
  });
});
