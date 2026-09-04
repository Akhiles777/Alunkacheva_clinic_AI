import { describe, expect, it } from "vitest";
import {
  addressForm,
  analyzeStyle,
  buildPatientProfile,
  MIN_MESSAGES_FOR_STYLE,
  type ProfileMessage,
  type ProfileVisit,
} from "./patient-profile";

const NOW = new Date("2026-09-04T12:00:00+03:00");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 3600 * 1000);

const visit = (over: Partial<ProfileVisit> = {}): ProfileVisit => ({
  at: daysAgo(10),
  status: "ARRIVED",
  staffName: "Омарова И.",
  services: [{ title: "БОС-терапия, сеанс", amount: 2800 }],
  revenue: 2800,
  ...over,
});

let n = 0;
const msg = (over: Partial<ProfileMessage> = {}): ProfileMessage => ({
  direction: "IN",
  authorType: "PATIENT",
  body: "Здравствуйте, подскажите цену",
  at: daysAgo(++n),
  hasAttachment: false,
  clinicHour: 14,
  ...over,
});

describe("что человек берёт", () => {
  it("услуги считаются по составу визита, а не по первой", () => {
    const p = buildPatientProfile(
      [
        visit({
          services: [
            { title: "Взрослый приём", amount: 8000 },
            { title: "Детский приём", amount: 5000 },
          ],
          revenue: 13000,
        }),
      ],
      [],
      NOW,
    );
    expect(p.services.map((s) => s.title)).toEqual(["Взрослый приём", "Детский приём"]);
    expect(p.money.total).toBe(13000);
  });

  it("несостоявшиеся визиты в предпочтения не идут", () => {
    const p = buildPatientProfile([visit({ status: "NO_SHOW" }), visit({ status: "CANCELLED" })], [], NOW);
    expect(p.services).toEqual([]);
    expect(p.visits.noShow).toBe(1);
    expect(p.visits.cancelled).toBe(1);
  });

  /**
   * Прошедший приём без отметки исхода — не состоявшийся и не неявка (§8).
   * В карточке это видно так же, как в отчётах.
   */
  it("прошедший приём без отметки считается отдельно", () => {
    const p = buildPatientProfile([visit({ status: "CONFIRMED", at: daysAgo(5) })], [], NOW);
    expect(p.visits.unmarked).toBe(1);
    expect(p.visits.arrived).toBe(0);
  });

  it("средний чек — по оплаченным приёмам, сеанс курса его не занижает", () => {
    const p = buildPatientProfile(
      [visit({ revenue: 6000 }), visit({ revenue: 0 })],
      [],
      NOW,
    );
    expect(p.money.avgCheck).toBe(6000);
    expect(p.money.paidVisits).toBe(1);
  });

  it("без оплаченных приёмов чек неизвестен, а не ноль", () => {
    const p = buildPatientProfile([visit({ revenue: 0 })], [], NOW);
    expect(p.money.avgCheck).toBeNull();
  });
});

describe("ритм визитов", () => {
  it("медиана по промежуткам между состоявшимися визитами", () => {
    const p = buildPatientProfile(
      [visit({ at: daysAgo(21) }), visit({ at: daysAgo(14) }), visit({ at: daysAgo(7) })],
      [],
      NOW,
    );
    expect(p.rhythm.medianDays).toBe(7);
    expect(p.rhythm.gaps).toBe(2);
  });

  it("одного визита для ритма мало", () => {
    const p = buildPatientProfile([visit()], [], NOW);
    expect(p.rhythm.medianDays).toBeNull();
  });
});

describe("манера общения", () => {
  it("«вы» и «ты» различаются по словам, а не по подстроке", () => {
    // «выписка» и «стыдно» не должны решать за человека.
    expect(addressForm(["Пришлите выписку, стыдно спрашивать"])).toBeNull();
    expect(addressForm(["Вы работаете завтра?", "У вас есть окно?"])).toBe("formal");
    expect(addressForm(["ты во сколько открываешься"])).toBe("informal");
  });

  it("время ответа считается только там, где ответ был", () => {
    const s = analyzeStyle([
      { ...msg({ direction: "OUT", authorType: "STAFF", at: new Date("2026-09-01T10:00:00+03:00") }) },
      { ...msg({ at: new Date("2026-09-01T13:00:00+03:00") }) },
      // Наше сообщение без ответа — молчание временем ответа не является.
      { ...msg({ direction: "OUT", authorType: "STAFF", at: new Date("2026-09-02T10:00:00+03:00") }) },
    ]);
    expect(s.medianReplyMinutes).toBe(180);
  });

  it("приветствие считается по началу сообщения", () => {
    const s = analyzeStyle([
      msg({ body: "Здравствуйте, а завтра есть окно?" }),
      msg({ body: "Добрый день!" }),
      msg({ body: "а сколько стоит" }),
    ]);
    expect(s.greetsShare).toBeCloseTo(2 / 3);
  });

  /**
   * Порог наблюдений — главная защита от выдумки: совет, построенный на одном
   * сообщении, администратор понесёт в разговор с живым человеком.
   */
  it("меньше пяти сообщений — о манере не судим", () => {
    const s = analyzeStyle([msg(), msg()]);
    expect(s.enough).toBe(false);
    const p = buildPatientProfile([], [msg(), msg()], NOW);
    expect(p.advice.every((a) => !a.text.includes("Здоровается"))).toBe(true);
  });

  it("сообщений хватило — советы появляются с основанием", () => {
    const many = Array.from({ length: MIN_MESSAGES_FOR_STYLE }, () =>
      msg({ body: "Здравствуйте! Вы работаете?", clinicHour: 21 }),
    );
    const p = buildPatientProfile([], many, NOW);
    expect(p.advice.length).toBeGreaterThan(0);
    expect(p.advice.every((a) => a.basis.length > 0)).toBe(true);
    expect(p.advice.some((a) => a.text.includes("вечером"))).toBe(true);
  });

  it("сообщения бота манеру пациента не портят", () => {
    const s = analyzeStyle([
      msg({ direction: "OUT", authorType: "BOT", body: "Здравствуйте! Чем помочь?" }),
      msg({ body: "цена" }),
    ]);
    expect(s.messages).toBe(1);
    expect(s.greetsShare).toBe(0);
  });
});

describe("советы", () => {
  it("просил человека дважды — агенту разговор не отдаём", () => {
    const many = Array.from({ length: MIN_MESSAGES_FOR_STYLE }, (_, i) =>
      msg({ body: i < 2 ? "позовите живого человека" : "спасибо" }),
    );
    const p = buildPatientProfile([], many, NOW);
    expect(p.advice.some((a) => a.text.includes("не отдавайте разговор ассистенту"))).toBe(true);
  });

  it("две неявки — предложить подтверждение накануне", () => {
    const p = buildPatientProfile([visit({ status: "NO_SHOW" }), visit({ status: "NO_SHOW" })], [], NOW);
    expect(p.advice.some((a) => a.text.includes("подтвердите"))).toBe(true);
  });

  it("пустая карточка советов не выдумывает", () => {
    const p = buildPatientProfile([], [], NOW);
    expect(p.advice).toEqual([]);
    expect(p.style.enough).toBe(false);
  });
});
