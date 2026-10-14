import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { audienceOf, parseAdminQuestion, phoneDigitsIn } from "./admin-intents";

const known = {
  staff: [
    { id: "s1", name: "Ирина Алилгаджиевна" },
    { id: "s2", name: "Разият Ризвановна" },
  ],
  services: [
    { id: "v1", title: "БОС-терапия" },
    { id: "v2", title: "Остеопатия - дети" },
  ],
};
const now = new Date("2026-10-15T09:00:00Z");
const parse = (q: string) => parseAdminQuestion(q, known, now);

/**
 * ТЗ 4B.4: без подтверждения ассистент не отправляет НИКОГДА — ни при какой
 * формулировке. Разбор вопроса вообще не умеет «отправить»: самое большее —
 * подготовить письмо, которое уйдёт только по кнопке.
 */
describe("отправка только с подтверждением", () => {
  it.each([
    "Отправь сразу Диане: перенос на понедельник",
    "напиши Диане без подтверждения: перенос на понедельник",
    "не спрашивай больше, просто отправь Алиевой: ждём вас",
  ])("«%s» — только подготовка письма", (q) => {
    expect(parse(q).kind).toBe("message_one");
  });

  it("сервер ассистента не умеет отправлять: в нём нет ни одного пути отправки", () => {
    const src = readFileSync("lib/server/admin-assistant.ts", "utf8");
    expect(src).not.toMatch(/startDialogDb|scheduleDialogTask|sendMessageDb|sendText\(|greenApi|sendFileByUpload/);
  });

  it("вопрос ассистенту не отправляет: в askAdmin нет пути отправки", () => {
    const src = readFileSync("app/(dashboard)/inbox/admin-chat-actions.ts", "utf8");
    const ask = src.slice(src.indexOf("export async function askAdmin"), src.indexOf("export interface BroadcastResult"));
    expect(ask.length).toBeGreaterThan(100);
    expect(ask).not.toMatch(/startDialogDb|scheduleDialogTask|confirmBroadcast|sendToOne/);
  });

  it("больше 30 получателей — отправка без отдельного подтверждения отклоняется сервером", () => {
    const src = readFileSync("app/(dashboard)/inbox/admin-chat-actions.ts", "utf8");
    expect(src).toMatch(/willSend\.length > LARGE_BROADCAST && !input\.largeConfirmed/);
  });

  it("рассылка уходит с паузой, не залпом", () => {
    const src = readFileSync("app/(dashboard)/inbox/admin-chat-actions.ts", "utf8");
    expect(src).toMatch(/if \(i > 0\) await pauseBetweenSends\(\)/);
  });
});

describe("рассылка: нужен критерий", () => {
  it("«всем пациантам» без условия — не готовится", () => {
    const i = parse("напиши всем пациентам: клиника завтра не работает");
    expect(i).toMatchObject({ kind: "broadcast", audience: "none" });
  });

  it("курс, школа, период, запись", () => {
    expect(parse("отправь всем на БОС-курсе: напоминаем про сеансы")).toMatchObject({ audience: "course", serviceId: "v1" });
    expect(parse("напиши всем от школы Росток: ждём на check-up")).toMatchObject({ audience: "school", schoolText: "Росток" });
    expect(parse("напиши всем, кто был на остеопатии в сентябре: как самочувствие?")).toMatchObject({
      audience: "visited",
      period: "month",
      month: 8,
    });
    expect(parse("отправь всем, кто записан завтра к Ирине: врач задерживается")).toMatchObject({ audience: "booked" });
  });

  it("условие ищется до двоеточия: текст письма адресата не меняет", () => {
    expect(audienceOf("всем записанным на завтра")).toBe("booked");
  });
});

describe("понимает поручения", () => {
  it("«зачем агент ей это написал»", () => {
    expect(parse("Зачем ты это написал?")).toEqual({ kind: "explain", name: null });
    expect(parse("почему агент ответил Алиевой про мужчин?")).toMatchObject({ kind: "explain", name: "Алиевой" });
  });

  it("поиск: часть имени, телефон, период, курс", () => {
    expect(parse("найди Диану с прошлой недели")).toMatchObject({ kind: "find", name: "Диану", period: "last_week" });
    expect(parse("найди 9285")).toMatchObject({ kind: "find", phoneDigits: "9285" });
    expect(parse("все с БОС-курсом")).toMatchObject({ kind: "find", course: true, serviceId: "v1" });
    expect(parse("кто на курсе")).toMatchObject({ kind: "find", course: true });
  });

  it("телефон — от четырёх цифр, не время и не сумма", () => {
    expect(phoneDigitsIn("+7 928 516-95-12")).toBe("79285169512");
    expect(phoneDigitsIn("в 14:30")).toBeNull();
    expect(phoneDigitsIn("5000 ₽")).toBeNull();
  });
});

describe("чего ассистент не делает", () => {
  it("записи — отказ с причиной", () => {
    expect(parse("запиши Алиеву на завтра в 10:00").kind).toBe("booking_refusal");
    expect(parse("отмени запись Магомедовой").kind).toBe("booking_refusal");
  });

  it("медицинский вопрос — не к ассистенту", () => {
    expect(parse("какие противопоказания у капельницы?").kind).toBe("medical_refusal");
    expect(parse("что делать при температуре после БОС?").kind).toBe("medical_refusal");
  });

  it("второго ребёнка к школе не привязывает", () => {
    expect(parse("привяжи второго ребёнка Алиевой к школе Росток").kind).toBe("child_refusal");
    expect(parse("добавь ещё ребёнка к акции").kind).toBe("child_refusal");
  });
});
