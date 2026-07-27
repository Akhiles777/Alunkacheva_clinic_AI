import { describe, expect, it } from "vitest";
import {
  patientMatches,
  primaryPhone,
  searchPatientsByAnyPhone,
  validateSinglePrimary,
  type PatientLike,
} from "./patient-search";

const family: PatientLike[] = [
  {
    id: "parent",
    name: "Гринберг Ирина Львовна",
    phones: [
      { phone: "+79161234567", isPrimary: true },
      { phone: "+79031112233", isPrimary: false }, // WhatsApp на другом номере
    ],
  },
  {
    id: "child",
    name: "Гринберг Пётр",
    // Ребёнок записан на телефон родителя.
    phones: [{ phone: "+79161234567", isPrimary: true }],
  },
  {
    id: "other",
    name: "Седых Дмитрий",
    phones: [{ phone: "+79267778899", isPrimary: true }],
  },
];

describe("поиск по нескольким телефонам", () => {
  it("находит по второму (не основному) номеру", () => {
    const found = searchPatientsByAnyPhone(family, "8 903 111 22 33");
    expect(found.map((p) => p.id)).toEqual(["parent"]);
  });

  it("номер в любом формате приводится к одному", () => {
    for (const q of ["+7 916 123-45-67", "89161234567", "9161234567", "916 123 45 67"]) {
      const ids = searchPatientsByAnyPhone(family, q).map((p) => p.id);
      // Номер общий у родителя и ребёнка — находит обоих, не склеивая их.
      expect(ids.sort(), q).toEqual(["child", "parent"]);
    }
  });

  it("частичный ввод номера тоже находит", () => {
    expect(searchPatientsByAnyPhone(family, "7778899").map((p) => p.id)).toEqual(["other"]);
  });

  it("находит по имени", () => {
    expect(searchPatientsByAnyPhone(family, "седых").map((p) => p.id)).toEqual(["other"]);
  });

  it("пустой запрос возвращает всех", () => {
    expect(searchPatientsByAnyPhone(family, "  ").length).toBe(3);
  });

  it("одна-две цифры не считаются телефоном", () => {
    expect(patientMatches(family[0], "79")).toBe(false);
  });

  it("семья на одном номере остаётся разными пациентами", () => {
    // Общий номер находит двоих — система не должна их схлопывать.
    const shared = searchPatientsByAnyPhone(family, "+79161234567");
    expect(new Set(shared.map((p) => p.id)).size).toBe(2);
  });
});

describe("инвариант основного номера", () => {
  it("ровно один isPrimary — валидно", () => {
    expect(validateSinglePrimary(family[0].phones)).toBe(true);
  });

  it("ноль или два основных — невалидно", () => {
    expect(validateSinglePrimary([{ phone: "a" }, { phone: "b" }])).toBe(false);
    expect(
      validateSinglePrimary([
        { phone: "a", isPrimary: true },
        { phone: "b", isPrimary: true },
      ]),
    ).toBe(false);
  });

  it("primaryPhone возвращает основной только при однозначности", () => {
    expect(primaryPhone(family[0].phones)).toBe("+79161234567");
    expect(primaryPhone([{ phone: "a" }])).toBeNull();
  });
});
