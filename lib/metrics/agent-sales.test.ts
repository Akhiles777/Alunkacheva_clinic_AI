import { describe, expect, it } from "vitest";
import { agentCollectedData, salesOf, totalsOf, type SaleMessage } from "./agent-sales";
import { looksLikeIntake } from "@/lib/agent/intake";

const at = (min: number) => new Date(Date.UTC(2026, 8, 1, 10, min));

const bot = (min: number, body: string): SaleMessage => ({
  at: at(min),
  direction: "OUT",
  authorType: "BOT",
  body,
});
const patient = (min: number, body: string): SaleMessage => ({
  at: at(min),
  direction: "IN",
  authorType: "PATIENT",
  body,
});
const staff = (min: number, body: string): SaleMessage => ({
  at: at(min),
  direction: "OUT",
  authorType: "STAFF",
  body,
});

/**
 * Продажа по определению заказчика: ассистент САМ довёл человека до готовой
 * заявки, а администратору осталось поставить время.
 */
describe("ассистент довёл до заявки", () => {
  it("попросил данные — пациент их прислал", () => {
    const messages = [
      patient(0, "Здравствуйте, хочу записаться к остеопату"),
      bot(1, "Взрослый приём — 8000 ₽. Пришлите, пожалуйста, ФИО, возраст и кратко причину обращения."),
      patient(5, "Магомедова Гульбара Халитовна, 34 года, боли в пояснице"),
    ];
    expect(agentCollectedData(messages, looksLikeIntake)?.collectedAt).toEqual(at(5));
  });

  it("пациент прислал данные сам, ассистент их принял", () => {
    const messages = [
      patient(0, "Магомедова Гульбара Халитовна, 34 года, боли в пояснице"),
      bot(1, "Спасибо, записал(а). Администратор подберёт время."),
    ];
    expect(agentCollectedData(messages, looksLikeIntake)).not.toBeNull();
  });

  /**
   * Главное разграничение: если разговор с самого начала вёл человек,
   * записывать заявку в заслугу ассистента — приписывать себе чужую работу.
   */
  it("разговор вёл администратор — не продажа ассистента", () => {
    const messages = [
      patient(0, "Здравствуйте, хочу записаться"),
      staff(1, "Здравствуйте! Подскажите ваше ФИО и возраст"),
      patient(5, "Магомедова Гульбара Халитовна, 34 года, боли в пояснице"),
    ];
    expect(agentCollectedData(messages, looksLikeIntake)).toBeNull();
  });

  it("данных пациент так и не прислал — не продажа", () => {
    const messages = [
      patient(0, "Хочу записаться"),
      bot(1, "Пришлите, пожалуйста, ФИО, возраст и кратко причину обращения."),
      patient(5, "А сколько стоит?"),
    ];
    expect(agentCollectedData(messages, looksLikeIntake)).toBeNull();
  });
});

describe("что засчитывается в продажу", () => {
  const messages = [
    patient(0, "Хочу записаться к остеопату"),
    bot(1, "Пришлите, пожалуйста, ФИО, возраст и кратко причину обращения."),
    patient(5, "Магомедова Гульбара Халитовна, 34 года, боли в пояснице"),
  ];
  const base = { conversationId: "c1", patientId: "p1", messages };

  it("запись после сбора данных — продажа", () => {
    const sales = salesOf(
      {
        ...base,
        appointments: [
          {
            id: "a1",
            createdAt: at(30),
            status: "ARRIVED",
            revenue: 8000,
            serviceTitles: ["Взрослый прием - остеопатия"],
          },
        ],
      },
      looksLikeIntake,
    );
    expect(sales).toHaveLength(1);
    expect(sales[0].revenue).toBe(8000);
  });

  it("запись, сделанная ДО разговора, не считается", () => {
    const sales = salesOf(
      {
        ...base,
        appointments: [
          { id: "a0", createdAt: at(-100), status: "ARRIVED", revenue: 8000, serviceTitles: ["Приём"] },
        ],
      },
      looksLikeIntake,
    );
    expect(sales).toHaveLength(0);
  });

  it("отменённая запись продажей не считается", () => {
    const sales = salesOf(
      {
        ...base,
        appointments: [
          { id: "a2", createdAt: at(30), status: "CANCELLED", revenue: 0, serviceTitles: ["Приём"] },
        ],
      },
      looksLikeIntake,
    );
    expect(sales).toHaveLength(0);
  });

  /** План не выручка (§8): деньги считаем только у состоявшихся визитов. */
  it("будущая запись идёт в счёт заявок, но не в деньги", () => {
    const sales = salesOf(
      {
        ...base,
        appointments: [
          { id: "a3", createdAt: at(30), status: "CONFIRMED", revenue: 8000, serviceTitles: ["Приём"] },
        ],
      },
      looksLikeIntake,
    );
    expect(sales).toHaveLength(1);
    expect(sales[0].revenue).toBe(0);
    expect(sales[0].arrived).toBe(false);
  });
});

describe("сводка по услугам", () => {
  it("считает записи, состоявшиеся визиты и деньги", () => {
    const totals = totalsOf([
      {
        conversationId: "c1",
        appointmentId: "a1",
        services: ["Остеопатия"],
        revenue: 8000,
        arrived: true,
        at: at(0),
      },
      {
        conversationId: "c2",
        appointmentId: "a2",
        services: ["Остеопатия"],
        revenue: 0,
        arrived: false,
        at: at(0),
      },
    ]);
    expect(totals.bookings).toBe(2);
    expect(totals.arrived).toBe(1);
    expect(totals.revenue).toBe(8000);
    expect(totals.byService[0]).toEqual({
      title: "Остеопатия",
      bookings: 2,
      arrived: 1,
      revenue: 8000,
    });
  });

  it("деньги визита из двух услуг делятся поровну", () => {
    const totals = totalsOf([
      {
        conversationId: "c1",
        appointmentId: "a1",
        services: ["Взрослый приём", "Детский приём"],
        revenue: 13000,
        arrived: true,
        at: at(0),
      },
    ]);
    expect(totals.revenue).toBe(13000);
    expect(totals.byService.map((s) => s.revenue)).toEqual([6500, 6500]);
  });
});
