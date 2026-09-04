import { describe, expect, it } from "vitest";
import { buildQueue, sessionsToBook, type QueueCourse, type QueueInput } from "./callback-queue";

const NOW = new Date("2026-09-04T12:00:00+03:00");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 3600 * 1000);

const course = (over: Partial<QueueCourse> = {}): QueueCourse => ({
  courseId: "c1",
  title: "БОС-терапия",
  total: 10,
  used: 4,
  booked: 0,
  pricePerSession: 2800,
  lastSessionAt: daysAgo(20),
  thresholdDays: 14,
  thresholdFrom: "SERVICE",
  ...over,
});

const patient = (over: Partial<QueueInput> = {}): QueueInput => ({
  patientId: "p1",
  patientName: "Иванова А.",
  hasFutureBooking: false,
  lastVisitAt: daysAgo(20),
  lastVisitTitle: "БОС-терапия",
  thresholdDays: 14,
  thresholdFrom: "SERVICE",
  servicePrice: 2800,
  noShowAt: null,
  noShowTitle: null,
  noShowThresholdDays: 14,
  noShowThresholdFrom: "SERVICE",
  noShowPrice: 8000,
  courses: [],
  ...over,
});

describe("будущая запись снимает с очереди", () => {
  /**
   * Единственное, что убирает человека из списка. Не «написали», не
   * «пообещал прийти» — запись. Иначе очередь становится списком добрых
   * намерений.
   */
  it("записанный вперёд не попадает в очередь ни по одному поводу", () => {
    const q = buildQueue(
      [patient({ hasFutureBooking: true, courses: [course()], noShowAt: daysAgo(2) })],
      NOW,
    );
    expect(q.rows).toHaveLength(0);
  });

  it("без записи — попадает", () => {
    const q = buildQueue([patient({ courses: [course()] })], NOW);
    expect(q.rows[0].kind).toBe("COURSE_STALLED");
  });
});

describe("пороги — из настроек услуги", () => {
  it("порог не пройден — человека не зовут", () => {
    const q = buildQueue(
      [patient({ courses: [course({ lastSessionAt: daysAgo(10), thresholdDays: 14 })] })],
      NOW,
    );
    expect(q.rows).toHaveLength(0);
  });

  it("порог пройден — зовут, и порог назван в основании", () => {
    const q = buildQueue(
      [patient({ courses: [course({ lastSessionAt: daysAgo(15), thresholdDays: 14 })] })],
      NOW,
    );
    expect(q.rows[0].basis).toContain("порог услуги 14 дн.");
  });

  /**
   * У разных услуг ритм разный: БОС ходят раз в неделю, остеопатию раз в
   * месяц. Одно число на всех означало бы, что половину зовут рано, а
   * половину — поздно.
   */
  it("у разных услуг разные пороги", () => {
    const q = buildQueue(
      [
        patient({ patientId: "бос", courses: [course({ lastSessionAt: daysAgo(10), thresholdDays: 7 })] }),
        patient({ patientId: "остео", courses: [course({ courseId: "c2", lastSessionAt: daysAgo(10), thresholdDays: 30 })] }),
      ],
      NOW,
    );
    expect(q.rows.map((r) => r.patientId)).toEqual(["бос"]);
  });

  /**
   * Порога нет — придумывать его за клинику мы не вправе. Но и молчать
   * нельзя: экран выглядел бы пустым при полной базе.
   */
  it("порог не задан — в очередь не идёт, но считается отдельно", () => {
    const q = buildQueue(
      [patient({ thresholdDays: null, courses: [course({ thresholdDays: null })] })],
      NOW,
    );
    expect(q.rows).toHaveLength(0);
    expect(q.withoutThreshold).toBe(1);
  });

  it("спящий без порога услуги тоже считается отдельно", () => {
    const q = buildQueue([patient({ thresholdDays: null, lastVisitAt: daysAgo(200) })], NOW);
    expect(q.rows).toHaveLength(0);
    expect(q.withoutThreshold).toBe(1);
  });
});

describe("поводы", () => {
  it("курс на финише считается по НЕзаписанным сеансам", () => {
    // Осталось два сеанса, и оба уже стоят в расписании — звать некого.
    const q = buildQueue(
      [patient({ courses: [course({ used: 8, booked: 2, lastSessionAt: daysAgo(3) })] })],
      NOW,
    );
    expect(q.rows).toHaveLength(0);
  });

  it("курс на финише: осталось дозаписать два", () => {
    const q = buildQueue(
      [patient({ courses: [course({ used: 8, booked: 0, lastSessionAt: daysAgo(3) })] })],
      NOW,
    );
    expect(q.rows[0].kind).toBe("COURSE_FINISHING");
    expect(q.rows[0].basis).toContain("дозаписать осталось 2");
  });

  it("не пришёл и не перезаписан", () => {
    const q = buildQueue(
      [patient({ noShowAt: daysAgo(3), noShowTitle: "Остеопатия", lastVisitAt: null })],
      NOW,
    );
    expect(q.rows[0].kind).toBe("NO_SHOW");
    expect(q.rows[0].basis).toContain("не перезаписан");
  });

  /**
   * Старая неявка — это уже не «не пришёл на той неделе»: звать надо другими
   * словами, и повод у человека другой.
   */
  it("неявка старше порога поводом уже не считается", () => {
    const q = buildQueue(
      [patient({ noShowAt: daysAgo(40), noShowThresholdDays: 14, lastVisitAt: null })],
      NOW,
    );
    expect(q.rows.some((r) => r.kind === "NO_SHOW")).toBe(false);
  });

  /**
   * Порог неявки — у пропущенной услуги, а не у последнего визита. У
   * пациента, который вообще ни разу не дошёл, порога последнего визита нет
   * вовсе, и неявка трёхлетней давности висела бы в списке вечно.
   */
  it("без порога у пропущенной услуги неявка в список не идёт", () => {
    const q = buildQueue(
      [patient({ noShowAt: daysAgo(3), noShowThresholdDays: null, lastVisitAt: null })],
      NOW,
    );
    expect(q.rows).toHaveLength(0);
    expect(q.withoutThreshold).toBe(1);
  });

  /**
   * Сумма — цена пропущенной услуги. Человек не пришёл на остеопатию за
   * 8 000, и в строке должна стоять она, а не цена того, на что он ходил в
   * прошлом году.
   */
  it("сумма неявки — цена пропущенной услуги", () => {
    const q = buildQueue(
      [
        patient({
          noShowAt: daysAgo(3),
          noShowPrice: 8000,
          servicePrice: 1500,
          lastVisitAt: null,
        }),
      ],
      NOW,
    );
    expect(q.rows[0].money).toBe(8000);
  });

  it("запасной порог клиники назван своим именем", () => {
    const q = buildQueue(
      [
        patient({
          thresholdFrom: "CLINIC",
          lastVisitAt: daysAgo(90),
          thresholdDays: 30,
        }),
      ],
      NOW,
    );
    expect(q.rows[0].basis).toContain("запасной порог клиники 30 дн.");
  });

  it("спящий: давно не был, курса нет", () => {
    const q = buildQueue(
      [patient({ lastVisitAt: daysAgo(90), thresholdDays: 30, courses: [] })],
      NOW,
    );
    expect(q.rows[0].kind).toBe("SLEEPING");
    expect(q.rows[0].basis).toContain("последний визит 90 дн. назад");
  });

  it("пациент с курсом спящим не считается: у него свой повод", () => {
    const q = buildQueue(
      [patient({ lastVisitAt: daysAgo(90), courses: [course({ lastSessionAt: daysAgo(90) })] })],
      NOW,
    );
    expect(q.rows).toHaveLength(1);
    expect(q.rows[0].kind).toBe("COURSE_STALLED");
  });

  /**
   * Звонят человеку, а не поводу: две строки про одного пациента — это два
   * звонка об одном и том же.
   */
  it("один человек — одна строка, повод сильнейший", () => {
    const q = buildQueue(
      [patient({ noShowAt: daysAgo(2), courses: [course()] })],
      NOW,
    );
    expect(q.rows).toHaveLength(1);
    expect(q.rows[0].kind).toBe("COURSE_STALLED");
  });
});

describe("деньги", () => {
  it("сортировка по сумме, дорогое сверху", () => {
    const q = buildQueue(
      [
        patient({ patientId: "дёшево", courses: [course({ courseId: "a", used: 9, total: 10, lastSessionAt: daysAgo(30) })] }),
        patient({ patientId: "дорого", courses: [course({ courseId: "b", used: 1, total: 10, lastSessionAt: daysAgo(30) })] }),
      ],
      NOW,
    );
    expect(q.rows.map((r) => r.patientId)).toEqual(["дорого", "дёшево"]);
  });

  /**
   * Деньги за курс клиника уже получила — это обязательство, а не потенциал.
   * Цена по прайсу — наоборот, план, который может не состояться (§8). На
   * экране они подписаны по-разному, поэтому и различаются здесь.
   */
  it("курсовые деньги — оплаченные вперёд, прайсовые — потенциал", () => {
    const q = buildQueue(
      [
        patient({ patientId: "курс", courses: [course()] }),
        patient({ patientId: "спящий", lastVisitAt: daysAgo(90), thresholdDays: 30 }),
      ],
      NOW,
    );
    expect(q.rows.find((r) => r.patientId === "курс")?.moneyKind).toBe("PREPAID");
    expect(q.rows.find((r) => r.patientId === "спящий")?.moneyKind).toBe("POTENTIAL");
  });

  it("неизвестная сумма не превращается в ноль и уходит вниз", () => {
    const q = buildQueue(
      [
        patient({ patientId: "без цены", servicePrice: null, lastVisitAt: daysAgo(90), thresholdDays: 30 }),
        patient({ patientId: "с ценой", servicePrice: 1000, lastVisitAt: daysAgo(90), thresholdDays: 30 }),
      ],
      NOW,
    );
    expect(q.rows.map((r) => r.patientId)).toEqual(["с ценой", "без цены"]);
    expect(q.rows[1].money).toBeNull();
  });

  it("сумма курса — за неотработанные сеансы", () => {
    const q = buildQueue([patient({ courses: [course({ used: 4, total: 10, pricePerSession: 2800 })] })], NOW);
    expect(q.rows[0].money).toBe(6 * 2800);
  });
});

describe("порядок строк", () => {
  it("устойчив при равных суммах и сроках", () => {
    const a = patient({ patientId: "a", courses: [course({ courseId: "ca" })] });
    const b = patient({ patientId: "b", courses: [course({ courseId: "cb" })] });
    expect(buildQueue([a, b], NOW).rows.map((r) => r.patientId)).toEqual(
      buildQueue([b, a], NOW).rows.map((r) => r.patientId),
    );
  });
});

describe("сеансы к дозаписи", () => {
  it("не уходит в минус", () => {
    expect(sessionsToBook(course({ total: 10, used: 10, booked: 3 }))).toBe(0);
  });
});
