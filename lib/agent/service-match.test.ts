import { describe, expect, it } from "vitest";
import { matchServices, whomFor } from "./service-match";

/** Прайс клиники — те самые строки, на которых ассистент ошибся. */
const SERVICES = [
  { title: "Остеопатия - дети, прием Ирины", price: 4900, durationMin: 45 },
  { title: "Остеопатия, приём Ирины", price: 8000, durationMin: 45 },
  { title: "Остеопатия, прием Разият", price: 5000, durationMin: 45 },
  { title: "Остеопатия - дети, прием Разият", price: 4000, durationMin: 45 },
  { title: "Беременная - остеопатия", price: 8000, durationMin: 45 },
  { title: "БОС-терапия", price: 5000, durationMin: 40 },
  { title: "Забор крови", price: 900, durationMin: 10 },
];

describe("для кого приём", () => {
  it("узнаёт ребёнка", () => {
    for (const t of [
      "Хотела ребенка записать к Ирине Алункачевой",
      "Записать сына к остеопату",
      "Детский приём сколько стоит?",
      "Дочке 6 лет, нужен остеопат",
    ]) {
      expect(whomFor(t), t).toBe("child");
    }
  });

  it("узнаёт взрослого", () => {
    expect(whomFor("Хочу записаться на взрослый приём")).toBe("adult");
    expect(whomFor("Записать мужа к остеопату")).toBe("adult");
  });

  it("не выбирает, когда сказано и то и другое", () => {
    // «Записать ребёнка и себя» — две услуги; гадать нельзя.
    expect(whomFor("Хочу записать ребенка и себя")).toBe("unknown");
    expect(whomFor("Сколько стоит приём остеопата?")).toBe("unknown");
  });
});

describe("подбор услуги под вопрос", () => {
  it("про ребёнка — только детские услуги", () => {
    const out = matchServices("Хотела ребенка записать к остеопату Ирине", SERVICES);
    expect(out.length).toBeGreaterThan(0);
    // Ровно та ошибка, из-за которой всё затевалось: взрослая цена 8000 в
    // ответе на вопрос про ребёнка.
    expect(out.every((s) => /дет/i.test(s.title))).toBe(true);
    expect(out.map((s) => s.price)).not.toContain(8000);
  });

  it("про взрослого — детские не предлагает", () => {
    const out = matchServices("Взрослый приём к остеопату Ирине", SERVICES);
    expect(out.every((s) => !/дет/i.test(s.title))).toBe(true);
  });

  it("имя врача сужает выбор", () => {
    const out = matchServices("Остеопатия к Разият для ребенка", SERVICES);
    expect(out[0].title).toContain("Разият");
    expect(out[0].price).toBe(4000);
  });

  it("беременность — отдельная услуга, не «взрослая вообще»", () => {
    const out = matchServices("Я беременна, хочу к остеопату", SERVICES);
    expect(out.some((s) => /беремен/i.test(s.title))).toBe(true);
  });

  it("ничего не подошло — пустой список, а не случайная услуга", () => {
    expect(matchServices("Сколько стоит МРТ?", SERVICES)).toEqual([]);
  });

  it("вопрос без возраста — показывает варианты, не выбирая за пациента", () => {
    const out = matchServices("Сколько стоит остеопатия?", SERVICES);
    expect(out.length).toBeGreaterThan(1);
  });
});

/**
 * Порог уверенности для карточки с ценой.
 *
 * Список услуг для модели можно собирать вольно — у неё есть контекст. Но тот
 * же список уходит человеку карточкой, когда модель не ответила, и там одно
 * случайно совпавшее слово превращалось в прайс не по теме: на «Доброго дня»
 * приходила «Тихая терапия „Перезагрузка“ — 4000 ₽».
 */
describe("порог совпадения услуги", () => {
  const services = [
    { title: 'Тихая терапия "Перезагрузка" (при тревожности и выгорании)', price: 4000, durationMin: 0 },
    { title: "Взрослый прием - остеопатия", price: 5000, durationMin: 60 },
  ];

  it("без порога совпадает по одному слову — это для модели", () => {
    expect(matchServices("сколько стоит терапия", services).length).toBeGreaterThan(0);
  });

  it("с порогом случайное пересечение отсекается", () => {
    expect(matchServices("доброго дня", services, 3, 0.5)).toEqual([]);
  });

  it("настоящий вопрос про услугу порог проходит", () => {
    const found = matchServices("тихая терапия перезагрузка", services, 3, 0.5);
    expect(found).toHaveLength(1);
    expect(found[0].price).toBe(4000);
  });
});
