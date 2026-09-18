import { describe, expect, it } from "vitest";
import { broadcastText, dateFrom, parseAdminQuestion, serviceIn, staffIn } from "./admin-intents";

/** Пятница, 18 сентября 2026, 12:00 по клинике. */
const NOW = new Date("2026-09-18T12:00:00+03:00");

const staff = [
  { id: "s1", name: "Алункачева Ирина Алилгаджиевна" },
  { id: "s2", name: "Омарова Ирина" },
  { id: "s3", name: "Разият Ризвановна" },
];
const services = [
  { id: "srv1", title: "Остеопатия, взрослый приём" },
  { id: "srv2", title: "БОС-терапия" },
  { id: "srv3", title: "Внутривенное капельное введение растворов" },
];
const known = { staff, services };

describe("день из вопроса", () => {
  it("по умолчанию — сегодня", () => {
    expect(dateFrom("сколько пациентов", NOW).label).toBe("сегодня");
  });

  it("узнаёт завтра, дату и день недели", () => {
    expect(dateFrom("сколько записано завтра", NOW).offset).toBe(1);
    expect(dateFrom("что было 14 сентября", NOW).iso).toBe("2026-09-14");
    expect(dateFrom("кто записан 20.09", NOW).iso).toBe("2026-09-20");
    // Ближайший понедельник после пятницы 18-го — 21-е.
    expect(dateFrom("кто записан в понедельник", NOW).iso).toBe("2026-09-21");
  });
});

describe("врач и услуга из вопроса", () => {
  it("врач назван однозначно", () => {
    expect(staffIn("сколько сегодня у Ирины Алилгаджиевны", staff).one?.id).toBe("s1");
  });

  it("одно имя на двоих — не угадываем", () => {
    const hit = staffIn("сколько сегодня у Ирины", staff);
    expect(hit.one).toBeNull();
    expect(hit.many).toHaveLength(2);
  });

  it("услуга узнаётся по корню названия", () => {
    expect(serviceIn("сколько сегодня на остеопатию", services)?.id).toBe("srv1");
    expect(serviceIn("сколько записано на БОС-терапию", services)?.id).toBe("srv2");
  });

  it("в вопросе без услуги её не выдумываем", () => {
    expect(serviceIn("сколько пациентов сегодня", services)).toBeNull();
  });
});

describe("разбор вопроса администратора", () => {
  it("сколько пациентов у врача на услугу", () => {
    const intent = parseAdminQuestion(
      "сколько пациентов сегодня у Ирины Алилгаджиевны на остеопатию?",
      known,
      NOW,
    );
    expect(intent).toMatchObject({ kind: "day_load", staffId: "s1", serviceId: "srv1" });
  });

  it("на какую сумму", () => {
    expect(parseAdminQuestion("на какую сумму сегодня?", known, NOW)).toMatchObject({
      kind: "day_money",
    });
  });

  it("сколько осталось принять", () => {
    expect(parseAdminQuestion("сколько ещё осталось принять сегодня", known, NOW)).toMatchObject({
      kind: "remaining",
    });
  });

  it("кто сейчас и кто следующий", () => {
    expect(parseAdminQuestion("кто сейчас на приёме?", known, NOW)).toMatchObject({ kind: "now" });
    expect(parseAdminQuestion("кто следующий у Разият Ризвановны?", known, NOW)).toMatchObject({
      kind: "now",
      staffId: "s3",
    });
  });

  it("свободные окна и неявки", () => {
    expect(parseAdminQuestion("какие свободные окна завтра?", known, NOW)).toMatchObject({
      kind: "free_slots",
    });
    expect(parseAdminQuestion("кто не пришёл сегодня?", known, NOW)).toMatchObject({
      kind: "attendance",
    });
  });

  it("список записанных", () => {
    expect(parseAdminQuestion("кто записан завтра к Омаровой Ирине?", known, NOW)).toMatchObject({
      kind: "schedule",
      staffId: "s2",
    });
  });

  it("рассылка: врач заболел", () => {
    const intent = parseAdminQuestion(
      "Отправь всем, кто записан сегодня к Ирине Алилгаджиевне: Добрый день! Врач заболел, приём переносится — мы свяжемся с вами.",
      known,
      NOW,
    );
    expect(intent).toMatchObject({ kind: "broadcast", staffId: "s1" });
    if (intent.kind === "broadcast") {
      expect(intent.text).toContain("Врач заболел");
      expect(intent.date.label).toBe("сегодня");
    }
  });

  it("рассылка без текста — текст пустой, сервер попросит его", () => {
    const intent = parseAdminQuestion("отправь всем записанным завтра", known, NOW);
    expect(intent).toMatchObject({ kind: "broadcast", text: "" });
  });

  it("текст берётся и из кавычек", () => {
    expect(broadcastText('напиши всем «Клиника сегодня закрыта»')).toBe("Клиника сегодня закрыта");
  });

  it("кто ждёт ответа, кому звонить, новые пациенты", () => {
    expect(parseAdminQuestion("кто ждёт ответа?", known, NOW).kind).toBe("waiting");
    expect(parseAdminQuestion("кому позвонить сегодня?", known, NOW).kind).toBe("callbacks");
    expect(parseAdminQuestion("сколько новых пациентов сегодня?", known, NOW).kind).toBe(
      "new_patients",
    );
  });

  it("вопрос про пациента по имени", () => {
    const intent = parseAdminQuestion("сколько должна Магомедова?", known, NOW);
    expect(intent).toMatchObject({ kind: "patient", name: "Магомедова" });
  });

  it("имя врача пациентом не считается", () => {
    const intent = parseAdminQuestion("что по записям к Разият?", known, NOW);
    expect(intent.kind).not.toBe("patient");
  });

  it("непонятный вопрос — так и говорим", () => {
    expect(parseAdminQuestion("сколько будет дважды два", known, NOW).kind).toBe("unknown");
    expect(parseAdminQuestion("", known, NOW).kind).toBe("unknown");
  });

  it("что умеешь — справка", () => {
    expect(parseAdminQuestion("что ты умеешь?", known, NOW).kind).toBe("help");
  });
});
