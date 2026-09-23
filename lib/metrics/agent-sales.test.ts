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
  // Новый пациент: до этой заявки у клиники на него ничего нет.
  const base = { conversationId: "c1", patientId: "p1", messages, earliestActivityAt: null };

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

/**
 * Продажа — это НОВЫЙ пациент (решение заказчика, сентябрь 2026).
 *
 * Постоянный человек, записавшийся снова, пришёл бы и без ассистента.
 */
describe("только новый пациент", () => {
  const messages = [
    patient(0, "Хочу записаться к остеопату"),
    bot(1, "Пришлите, пожалуйста, ФИО, возраст и кратко причину обращения."),
    patient(5, "Магомедова Гульбара Халитовна, 34 года, боли в пояснице"),
  ];
  const appointments = [
    {
      id: "a1",
      createdAt: at(30),
      status: "ARRIVED",
      revenue: 8000,
      serviceTitles: ["Взрослый прием - остеопатия"],
    },
  ];
  const base = { conversationId: "c1", patientId: "p1", messages, appointments };

  it("ничего до заявки — продажа", () => {
    expect(salesOf({ ...base, earliestActivityAt: null }, looksLikeIntake)).toHaveLength(1);
    // Самая ранняя запись — она же и есть: человек появился этой заявкой.
    expect(salesOf({ ...base, earliestActivityAt: at(30) }, looksLikeIntake)).toHaveLength(1);
  });

  it("был визит раньше — не продажа", () => {
    expect(salesOf({ ...base, earliestActivityAt: at(-60 * 24 * 30) }, looksLikeIntake)).toHaveLength(0);
  });

  it("была отменённая запись раньше — тоже не продажа", () => {
    // Отмена означает, что человек уже обращался, и привёл его кто-то другой.
    expect(salesOf({ ...base, earliestActivityAt: at(-10) }, looksLikeIntake)).toHaveLength(0);
  });
});

/**
 * Просьба о данных узнаётся тем же правилом, что и везде на платформе.
 *
 * Узкий образец видел только «пришлите … ФИО», а модель просит иначе — и
 * собранные ассистентом заявки не попадали в статистику владельца.
 */
describe("как узнаётся просьба о данных", () => {
  const sale = (ask: string, gap: SaleMessage[] = []) =>
    salesOf(
      {
        conversationId: "c1",
        patientId: "p1",
        earliestActivityAt: null,
        messages: [patient(0, "Хочу записаться к остеопату"), bot(1, ask), ...gap, patient(9, "Магомедова Гульбара Халитовна, 34 года, боли в пояснице")],
        appointments: [
          { id: "a1", createdAt: at(30), status: "ARRIVED", revenue: 8000, serviceTitles: ["Приём"] },
        ],
      },
      looksLikeIntake,
    );

  it("узнаёт живые формулировки модели", () => {
    for (const ask of [
      "Пришлите, пожалуйста, одним сообщением: ФИО, возраст и кратко причину обращения.",
      "Для записи мне нужны ФИО и возраст ребёнка, а также кратко причина обращения.",
      "Напишите, как зовут ребёнка и сколько ему лет.",
      "Чтобы записать вас, назовите ФИО и возраст.",
    ]) {
      expect(sale(ask), ask).toHaveLength(1);
    }
  });

  it("цена — не просьба о данных", () => {
    expect(sale("Детский приём — 5000 ₽, 40 минут.")).toHaveLength(0);
  });

  it("вопрос пациента между просьбой и анкетой заявку не теряет", () => {
    const gap = [patient(3, "А сколько длится приём?"), bot(4, "Сорок минут.")];
    expect(sale("Пришлите, пожалуйста, ФИО, возраст и кратко причину обращения.", gap)).toHaveLength(1);
  });
});
