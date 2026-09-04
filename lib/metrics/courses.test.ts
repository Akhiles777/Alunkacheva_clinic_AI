import { describe, expect, it } from "vitest";
import {
  courseCompletion,
  courseRepurchase,
  courseSessionRevenue,
  outstandingCourseValue,
  recognizeVisitRevenue,
  sessionInterval,
  splitCourseAmount,
  type CourseFact,
} from "./courses";

describe("splitCourseAmount", () => {
  it("делит ровную сумму поровну", () => {
    expect(splitCourseAmount(65000, 10)).toEqual(Array(10).fill(6500));
  });

  it("остаток от неровного деления кладёт на последний сеанс", () => {
    const parts = splitCourseAmount(10000, 3);
    expect(parts).toEqual([3333.33, 3333.33, 3333.34]);
  });

  it("сумма долей всегда равна сумме курса — курс сходится с кассой", () => {
    const cases: [number, number][] = [
      [65000, 10],
      [48000, 8],
      [59900, 12],
      [10000, 3],
      [0.03, 2],
      [1, 7],
    ];

    for (const [amount, sessions] of cases) {
      const parts = splitCourseAmount(amount, sessions);
      const sum = parts.reduce((total, part) => Math.round((total + part) * 100) / 100, 0);
      expect(sum, `${amount} / ${sessions}`).toBe(amount);
      expect(parts).toHaveLength(sessions);
    }
  });

  it("не порождает копеечный дрейф на длинных курсах", () => {
    const parts = splitCourseAmount(59900, 12);
    expect(parts.slice(0, 11)).toEqual(Array(11).fill(4991.66));
    expect(parts[11]).toBe(4991.74);
  });

  it("ругается на бессмысленный ввод", () => {
    expect(() => splitCourseAmount(1000, 0)).toThrow(RangeError);
    expect(() => splitCourseAmount(1000, -3)).toThrow(RangeError);
    expect(() => splitCourseAmount(1000, 2.5)).toThrow(RangeError);
    expect(() => splitCourseAmount(-1, 2)).toThrow(RangeError);
  });
});

describe("courseSessionRevenue", () => {
  it("возвращает долю конкретного сеанса", () => {
    expect(courseSessionRevenue(10000, 3, 1)).toBe(3333.33);
    expect(courseSessionRevenue(10000, 3, 3)).toBe(3333.34);
  });

  it("не пускает номер сеанса за пределы курса", () => {
    expect(() => courseSessionRevenue(10000, 3, 0)).toThrow(RangeError);
    expect(() => courseSessionRevenue(10000, 3, 4)).toThrow(RangeError);
  });
});

describe("recognizeVisitRevenue", () => {
  it("разовый визит признаёт целиком", () => {
    expect(recognizeVisitRevenue({ paidAmount: 7000, course: null })).toBe(7000);
  });

  it("курсовой визит признаёт долей курса, а не суммой продажи", () => {
    const revenue = recognizeVisitRevenue({
      paidAmount: 0,
      course: { amount: 65000, sessionsTotal: 10 },
      courseSessionIndex: 4,
    });
    expect(revenue).toBe(6500);
  });

  it("продажа курса не даёт пик в один день", () => {
    // Десять сеансов за 65 000 ₽: в день продажи признаётся 6 500, а не всё.
    const course = { amount: 65000, sessionsTotal: 10 };
    const daily = Array.from({ length: 10 }, (_, index) =>
      recognizeVisitRevenue({ paidAmount: 0, course, courseSessionIndex: index + 1 }),
    );

    expect(Math.max(...daily)).toBe(6500);
    expect(daily.reduce((sum, value) => sum + value, 0)).toBe(65000);
  });

  it("курсовой визит без номера сеанса выручку не признаёт", () => {
    // Лучше ноль, чем задвоение с продажей курса.
    expect(
      recognizeVisitRevenue({
        paidAmount: 65000,
        course: { amount: 65000, sessionsTotal: 10 },
        courseSessionIndex: null,
      }),
    ).toBe(0);
  });
});

describe("доходимость курсов", () => {
  const base = (over: Partial<CourseFact> = {}): CourseFact => ({
    courseId: "c1",
    patientId: "p1",
    serviceTitle: "БОС-терапия",
    purchasedAt: new Date("2026-06-01T10:00:00+03:00"),
    sessionsTotal: 10,
    sessionsUsed: 4,
    sessionsBooked: 0,
    pricePerSession: 2800,
    sessionDates: [new Date("2026-08-01T10:00:00+03:00")],
    thresholdDays: 14,
    hasFuture: false,
    ...over,
  });
  const NOW = new Date("2026-09-04T12:00:00+03:00");

  it("пройденный курс считается дошедшим", () => {
    const r = courseCompletion([base({ sessionsUsed: 10 })], NOW);
    expect(r.completed).toBe(1);
    expect(r.rate).toBe(1);
  });

  it("брошенный: сеансы не кончились, записи нет, порог пройден", () => {
    const r = courseCompletion([base()], NOW);
    expect(r.abandoned).toBe(1);
    expect(r.rate).toBe(0);
  });

  /**
   * Курс, купленный вчера, не «брошен» — он идёт. Считая его брошенным,
   * каждый свежий месяц показывал бы ноль доходимости, и по метрике
   * перестали бы смотреть.
   */
  it("идущий курс в долю не входит", () => {
    const r = courseCompletion(
      [base({ sessionDates: [new Date("2026-09-01T10:00:00+03:00")] })],
      NOW,
    );
    expect(r.inProgress).toBe(1);
    expect(r.rate).toBeNull();
  });

  it("курс с будущей записью идёт, даже если пауза длинная", () => {
    const r = courseCompletion([base({ hasFuture: true })], NOW);
    expect(r.inProgress).toBe(1);
  });

  /**
   * Незакрытые прошлые визиты «идущим» курс не делают: отметку «пришёл»
   * ставят не всегда, и такой курс никогда не стал бы брошенным — ровно у
   * тех пациентов, за которыми хуже всего следят.
   */
  it("висящие незакрытые визиты в прошлом курс не спасают", () => {
    const r = courseCompletion([base({ sessionsBooked: 3, hasFuture: false })], NOW);
    expect(r.abandoned).toBe(1);
  });

  it("без порога курс не решён и назван отдельно", () => {
    const r = courseCompletion([base({ thresholdDays: null })], NOW);
    expect(r.undecidable).toBe(1);
    expect(r.rate).toBeNull();
  });

  it("доля считается только по решившимся", () => {
    const r = courseCompletion(
      [
        base({ courseId: "a", sessionsUsed: 10 }),
        base({ courseId: "b" }),
        base({ courseId: "c", sessionDates: [new Date("2026-09-02T10:00:00+03:00")] }),
      ],
      NOW,
    );
    expect(r.rate).toBe(0.5);
    expect(r.inProgress).toBe(1);
  });

  it("сеансы считаются отдельным числом", () => {
    const r = courseCompletion([base({ sessionsUsed: 4, sessionsTotal: 10 })], NOW);
    expect(r.sessionsUsed).toBe(4);
    expect(r.sessionsPaid).toBe(10);
  });
});

describe("обязательства по курсам", () => {
  const NOW = new Date("2026-09-04T12:00:00+03:00");
  const base = (over: Partial<CourseFact> = {}): CourseFact => ({
    courseId: "c1",
    patientId: "p1",
    serviceTitle: "БОС-терапия",
    purchasedAt: new Date("2026-06-01T10:00:00+03:00"),
    sessionsTotal: 10,
    sessionsUsed: 4,
    sessionsBooked: 0,
    pricePerSession: 2800,
    sessionDates: [new Date("2026-08-01T10:00:00+03:00")],
    thresholdDays: 14,
    hasFuture: false,
    ...over,
  });

  it("считает неотработанные сеансы в рублях", () => {
    const r = outstandingCourseValue([base()], NOW);
    expect(r.sessions).toBe(6);
    expect(r.obligation).toBe(6 * 2800);
  });

  it("пройденный курс обязательств не оставляет", () => {
    const r = outstandingCourseValue([base({ sessionsUsed: 10 })], NOW);
    expect(r.courses).toBe(0);
    expect(r.obligation).toBe(0);
  });

  /**
   * Выпавшие из графика — те же деньги, но вернуть их труднее: человека надо
   * сначала позвать. Число показывается рядом, а не растворяется в общем.
   */
  it("выделяет деньги выпавших из графика", () => {
    const r = outstandingCourseValue(
      [
        base({ courseId: "идёт", sessionDates: [new Date("2026-09-02T10:00:00+03:00")] }),
        base({ courseId: "выпал" }),
      ],
      NOW,
    );
    expect(r.atRiskCourses).toBe(1);
    expect(r.atRisk).toBe(6 * 2800);
    expect(r.obligation).toBe(12 * 2800);
  });

  it("записанные вперёд сеансы считаются отдельно", () => {
    const r = outstandingCourseValue([base({ sessionsBooked: 2 })], NOW);
    expect(r.scheduledSessions).toBe(2);
  });
});

describe("интервал между сеансами", () => {
  const d = (iso: string) => new Date(`${iso}T10:00:00+03:00`);

  it("медиана и среднее считаются по промежуткам", () => {
    const r = sessionInterval([d("2026-08-01"), d("2026-08-08"), d("2026-08-15")]);
    expect(r.medianDays).toBe(7);
    expect(r.gaps).toBe(2);
  });

  /**
   * Один отпуск в три недели сдвигает среднее так, что типичный ритм
   * исчезает. Медиана его показывает, среднее стоит рядом.
   */
  it("медиана устойчива к одному длинному перерыву", () => {
    const r = sessionInterval([d("2026-08-01"), d("2026-08-08"), d("2026-08-15"), d("2026-09-20")]);
    expect(r.medianDays).toBe(7);
    expect(r.meanDays).toBeGreaterThan(10);
    expect(r.maxDays).toBe(36);
  });

  it("одному сеансу интервала не отвести", () => {
    const r = sessionInterval([d("2026-08-01")]);
    expect(r.medianDays).toBeNull();
    expect(r.gaps).toBe(0);
  });

  it("порядок дат на входе не важен", () => {
    const straight = sessionInterval([d("2026-08-01"), d("2026-08-08")]);
    const reversed = sessionInterval([d("2026-08-08"), d("2026-08-01")]);
    expect(reversed.medianDays).toBe(straight.medianDays);
  });
});

describe("повторные покупки курсов", () => {
  const NOW = new Date("2026-09-04T12:00:00+03:00");
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 3600 * 1000);

  it("купил второй курс в окне — вернулся", () => {
    const r = courseRepurchase(
      [{ patientId: "p1", finishedAt: daysAgo(120), laterPurchases: [daysAgo(90)] }],
      NOW,
    );
    expect(r.cohort).toBe(1);
    expect(r.repurchased).toBe(1);
    expect(r.rate).toBe(1);
    expect(r.medianDaysToRepurchase).toBe(30);
  });

  it("не купил, окно прошло — не вернулся", () => {
    const r = courseRepurchase(
      [{ patientId: "p1", finishedAt: daysAgo(200), laterPurchases: [] }],
      NOW,
    );
    expect(r.rate).toBe(0);
  });

  /**
   * У человека, прошедшего последний сеанс на прошлой неделе, ещё не было
   * времени вернуться. Записывать его в «не вернулся» — врать про клинику.
   */
  it("закончил недавно — в долю не идёт", () => {
    const r = courseRepurchase(
      [{ patientId: "p1", finishedAt: daysAgo(10), laterPurchases: [] }],
      NOW,
    );
    expect(r.cohort).toBe(0);
    expect(r.tooEarly).toBe(1);
    expect(r.rate).toBeNull();
  });

  it("успел вернуться до конца окна — считается сразу", () => {
    const r = courseRepurchase(
      [{ patientId: "p1", finishedAt: daysAgo(10), laterPurchases: [daysAgo(3)] }],
      NOW,
    );
    expect(r.cohort).toBe(1);
    expect(r.repurchased).toBe(1);
  });

  it("покупка позже окна возвратом не считается", () => {
    const r = courseRepurchase(
      [{ patientId: "p1", finishedAt: daysAgo(300), laterPurchases: [daysAgo(100)] }],
      NOW,
    );
    expect(r.repurchased).toBe(0);
  });

  it("покупка до конца курса не считается возвратом", () => {
    const r = courseRepurchase(
      [{ patientId: "p1", finishedAt: daysAgo(200), laterPurchases: [daysAgo(250)] }],
      NOW,
    );
    expect(r.repurchased).toBe(0);
  });

  it("пустая когорта — доля неизвестна, а не ноль", () => {
    const r = courseRepurchase([], NOW);
    expect(r.rate).toBeNull();
  });
});
