import { describe, expect, it } from "vitest";
import type { Patient } from "@/app/_data/store";
import { answerQuery } from "./engine";

function patient(over: Partial<Patient>): Patient {
  return {
    id: "p",
    name: "Тест",
    bornYear: null,
    firstSeen: "ранее",
    source: "Instagram",
    channel: "instagram",
    phones: [],
    notes: [],
    relations: [],
    courses: [],
    visits: [],
    messages: [],
    ...over,
  };
}
const v = (date: string) => ({ id: date, date, service: "S", doctor: "D", status: "arrived" as const, amount: 6500 });

const patients = [
  patient({ id: "g", name: "Гринберг Ирина Львовна", visits: [v("2 июля"), v("9 июля"), v("16 июля"), v("23 июля")] }),
  patient({
    id: "s",
    name: "Седых Дмитрий Петрович",
    source: "Рекомендация",
    courses: [{ id: "c", title: "Остеопатия, курс", used: 4, total: 10, status: "stalled", lastVisit: "18 дней назад" }],
  }),
];

describe("answerQuery", () => {
  it("интервал по конкретному пациенту", () => {
    const a = answerQuery("с каким интервалом ходит Гринберг?", patients);
    expect(a.text).toContain("Гринберг");
    expect(a.text).toContain("раз в 7 дней");
  });
  it("сводка", () => {
    const a = answerQuery("сделай сводку по пациентам", patients);
    expect(a.text).toContain("Всего пациентов: 2");
  });
  it("выпавшие из курса", () => {
    const a = answerQuery("кого пора вернуть?", patients);
    expect(a.text).toContain("Седых");
    expect(a.text).toContain("Остеопатия, курс");
  });
  it("источники", () => {
    const a = answerQuery("откуда приходят пациенты", patients);
    expect(a.text.toLowerCase()).toContain("instagram");
    expect(a.text).toContain("Рекомендация");
  });
  it("пустой/непонятный запрос → подсказка возможностей", () => {
    expect(answerQuery("", patients).text).toBeTruthy();
    expect(answerQuery("расскажи анекдот", patients).text).toContain("локально");
  });
});
