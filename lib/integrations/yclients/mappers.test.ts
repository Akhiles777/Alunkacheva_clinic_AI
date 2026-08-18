import { describe, expect, it } from "vitest";
import {
  guessServiceKind,
  mapClient,
  mapRecord,
  mapRecordStatus,
  mapResource,
  mapService,
  mapStaff,
  seanceToMinutes,
} from "./mappers";

describe("seanceToMinutes", () => {
  it("переводит секунды в минуты с округлением", () => {
    expect(seanceToMinutes(3600)).toBe(60);
    expect(seanceToMinutes(2700)).toBe(45);
    expect(seanceToMinutes(890)).toBe(15);
  });
  it("пустое/битое значение → 0", () => {
    expect(seanceToMinutes(undefined)).toBe(0);
    expect(seanceToMinutes(-10)).toBe(0);
  });
});

describe("guessServiceKind", () => {
  it("определяет направление по названию", () => {
    expect(guessServiceKind("Остеопатия, приём")).toBe("OSTEOPATHY");
    expect(guessServiceKind("БОС-терапия, сеанс")).toBe("BIOFEEDBACK");
    expect(guessServiceKind("IV-терапия, капельница")).toBe("IV_THERAPY");
    expect(guessServiceKind("Нейромедитация")).toBe("NEUROMEDITATION");
    expect(guessServiceKind("Забор анализов")).toBe("LAB");
    expect(guessServiceKind("Консультация администратора")).toBe("OTHER");
  });
});

describe("mapService", () => {
  it("берёт price, иначе price_min", () => {
    expect(mapService({ id: 1, title: "Остеопатия", price: 7000, seance_length: 3600 }).price).toBe(7000);
    expect(mapService({ id: 2, title: "БОС", price_min: 5000, seance_length: 2400 }).price).toBe(5000);
  });
  it("active=0 → неактивна", () => {
    expect(mapService({ id: 3, title: "X", active: 0 }).isActive).toBe(false);
    expect(mapService({ id: 4, title: "Y" }).isActive).toBe(true);
  });
});

describe("mapStaff", () => {
  it("уволенный → неактивен, пустая специальность → null", () => {
    expect(mapStaff({ id: 1, name: "Левин", specialization: "Остеопат", fired: 0 })).toEqual({
      yclientsStaffId: 1,
      name: "Левин",
      specialty: "Остеопат",
      isActive: true,
    });
    expect(mapStaff({ id: 2, name: "Ушёл", fired: 1 }).isActive).toBe(false);
    expect(mapStaff({ id: 3, name: "Без спец", specialization: "  " }).specialty).toBeNull();
  });
});

describe("mapResource", () => {
  it("маппит кабинет", () => {
    expect(mapResource({ id: 9, title: "Кабинет 1" })).toEqual({ yclientsResourceId: 9, name: "Кабинет 1" });
  });
});

describe("mapClient", () => {
  it("нормализует телефон в E.164", () => {
    expect(mapClient({ id: 5, name: "Иван", phone: "8 (916) 123-45-67" })).toEqual({
      yclientsId: 5,
      name: "Иван",
      phoneE164: "+79161234567",
      firstSeenAt: null,
    });
  });
  it("нераспознанный телефон → null, пустое имя → null", () => {
    const r = mapClient({ id: 6, name: "   ", phone: "abc" });
    expect(r.name).toBeNull();
    expect(r.phoneE164).toBeNull();
  });
});

describe("mapRecordStatus", () => {
  it("маппит visit_attendance", () => {
    expect(mapRecordStatus(-1)).toBe("NO_SHOW");
    expect(mapRecordStatus(0)).toBe("CREATED");
    expect(mapRecordStatus(1)).toBe("ARRIVED");
    expect(mapRecordStatus(2)).toBe("CONFIRMED");
    expect(mapRecordStatus(undefined)).toBe("CREATED");
  });
  it("удалённая запись → CANCELLED поверх всего", () => {
    expect(mapRecordStatus(1, true)).toBe("CANCELLED");
  });
});

describe("mapRecord", () => {
  it("суммирует выручку по услугам, берёт кабинет и телефон клиента", () => {
    const r = mapRecord({
      id: 100,
      staff_id: 7,
      datetime: "2026-07-30T11:00:00+03:00",
      seance_length: 5400,
      visit_attendance: 1,
      services: [
        { id: 2001, cost: 6500 },
        { id: 2002, cost: 500 },
      ],
      client: { phone: "89031112233" },
      resource_instances: [{ resource_id: 42 }],
    });
    expect(r.yclientsRecordId).toBe(100);
    expect(r.yclientsStaffId).toBe(7);
    expect(r.yclientsResourceId).toBe(42);
    expect(r.yclientsServiceIds).toEqual([2001, 2002]);
    expect(r.durationMin).toBe(90);
    expect(r.status).toBe("ARRIVED");
    expect(r.revenue).toBe(7000);
    expect(r.clientPhoneE164).toBe("+79031112233");
    expect(r.startAt.toISOString()).toBe("2026-07-30T08:00:00.000Z");
  });
});

describe("дата первого обращения", () => {
  it("берётся из YCLIENTS, а не из дня выгрузки", () => {
    // Иначе полторы тысячи человек с многолетней историей разом становятся
    // первичными, а «новые пациенты» за месяц импорта — вся база клиники.
    const r = mapClient({ id: 7, name: "Пациент", first_visit_date: "2023-11-09 12:00:00" });
    expect(r.firstSeenAt?.toISOString()).toBe("2023-11-09T00:00:00.000Z");
  });

  it("без даты у них — null, дальше решает выгрузка", () => {
    expect(mapClient({ id: 8 }).firstSeenAt).toBeNull();
    expect(mapClient({ id: 9, first_visit_date: "" }).firstSeenAt).toBeNull();
    expect(mapClient({ id: 10, first_visit_date: "не дата" }).firstSeenAt).toBeNull();
  });
});

/**
 * Приём девятнадцатого августа был помечен состоявшимся восемнадцатого. Так
 * бывает при переносе записи — отметка остаётся с прежнего дня — или когда её
 * ставят заранее. Такой визит даёт выручку, которой ещё нет, и завышает число
 * пришедших.
 */
describe("«пришёл» на визит, который ещё не начался", () => {
  const now = new Date("2026-08-18T20:00:00+03:00");

  it("завтрашний приём состоявшимся не считается", () => {
    const tomorrow = new Date("2026-08-19T10:00:00+03:00");
    expect(mapRecordStatus(1, false, tomorrow, now)).toBe("CONFIRMED");
  });

  it("приём, который уже прошёл, — состоявшийся", () => {
    const earlier = new Date("2026-08-18T09:00:00+03:00");
    expect(mapRecordStatus(1, false, earlier, now)).toBe("ARRIVED");
  });

  it("приём, начавшийся только что, — состоявшийся", () => {
    expect(mapRecordStatus(1, false, now, now)).toBe("ARRIVED");
  });

  it("неявку и отмену правило не трогает", () => {
    const tomorrow = new Date("2026-08-19T10:00:00+03:00");
    expect(mapRecordStatus(-1, false, tomorrow, now)).toBe("NO_SHOW");
    expect(mapRecordStatus(1, true, tomorrow, now)).toBe("CANCELLED");
  });

  it("без даты визита работает как раньше", () => {
    expect(mapRecordStatus(1)).toBe("ARRIVED");
  });
});
