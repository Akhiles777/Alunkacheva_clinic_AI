import { describe, expect, it } from "vitest";
import { matchPatient, type KnownPatient } from "./patient-identity";

/**
 * Сопоставление пациента при выгрузке из YCLIENTS. Ошибка здесь молча
 * разъезжает карточки: визиты уходят не тому человеку, а заметно это
 * становится через месяцы.
 */
const known: KnownPatient[] = [
  { id: "local", yclientsId: null, phones: ["+79991234567"] },
  { id: "imported", yclientsId: 500, phones: ["+79995554433"] },
];

describe("matchPatient", () => {
  it("узнаёт по идентификатору YCLIENTS", () => {
    expect(matchPatient({ yclientsId: 500, phone: null }, known)).toEqual({
      kind: "by-yclients-id",
      patientId: "imported",
    });
  });

  it("узнаёт заведённого вручную по телефону", () => {
    expect(matchPatient({ yclientsId: 777, phone: "+79991234567" }, known)).toEqual({
      kind: "by-phone",
      patientId: "local",
    });
  });

  it("телефон в другом написании — тот же человек", () => {
    for (const written of ["8 (999) 123-45-67", "+7 999 123 45 67", "79991234567"]) {
      expect(matchPatient({ yclientsId: null, phone: written }, known), written).toEqual({
        kind: "by-phone",
        patientId: "local",
      });
    }
  });

  it("идентификатор важнее телефона: он точен по определению", () => {
    const res = matchPatient({ yclientsId: 500, phone: "+79991234567" }, known);
    expect(res).toEqual({ kind: "by-yclients-id", patientId: "imported" });
  });

  it("незнакомый человек заводится заново", () => {
    expect(matchPatient({ yclientsId: 900, phone: "+79990000000" }, known)).toEqual({ kind: "new" });
  });

  it("неразобранный номер не считается совпадением", () => {
    expect(matchPatient({ yclientsId: null, phone: "звонить в будни" }, known)).toEqual({ kind: "new" });
  });

  it("пустая база — всегда новый пациент", () => {
    expect(matchPatient({ yclientsId: 1, phone: "+79991234567" }, [])).toEqual({ kind: "new" });
  });
});
