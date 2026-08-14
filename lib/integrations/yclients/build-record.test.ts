import { describe, expect, it } from "vitest";
import { buildRecordRow } from "./sync";
import type { SyncLookups } from "./lookups";

/**
 * Разбор записи YCLIENTS — ядро выгрузки. Ошибка здесь либо теряет визиты
 * молча, либо привязывает их не к тому человеку, и замечено это будет уже
 * после того, как отчёты разъедутся.
 */
function lookups(over: Partial<SyncLookups> = {}): SyncLookups {
  return {
    staffByYclientsId: new Map([[10, "staff-1"]]),
    defaultRoomByStaffId: new Map<string, string>(),
    roomByResourceId: new Map([[900, "room-1"]]),
    serviceByYclientsId: new Map([[55, "service-1"]]),
    patientByYclientsId: new Map([[7, "patient-1"]]),
    patientByPhone: new Map([["+79991234567", "patient-phone"]]),
    knownRecordIds: new Set<number>(),
    ...over,
  };
}

const base = {
  id: 1001,
  staff_id: 10,
  datetime: "2026-08-20T10:00:00+03:00",
  seance_length: 3600,
  services: [{ id: 55 }],
  client: { id: 7, phone: "+79990000000" },
  resource_instances: [{ resource_id: 900 }],
};

describe("buildRecordRow", () => {
  it("собирает визит со всеми связями", () => {
    const row = buildRecordRow("co", base, lookups());
    expect(row?.kind).toBe("row");
    if (row?.kind !== "row") return;
    expect(row.data.staffId).toBe("staff-1");
    expect(row.data.patientId).toBe("patient-1");
    expect(row.data.roomId).toBe("room-1");
    expect(row.data.primaryServiceId).toBe("service-1");
    expect(row.data.yclientsRecordId).toBe(1001);
    // Приехало из YCLIENTS — отправлять обратно нечего.
    expect(row.data.syncState).toBe("SYNCED");
  });

  it("удалённая запись помечается на удаление, а не пропадает", () => {
    expect(buildRecordRow("co", { ...base, deleted: true }, lookups())).toEqual({
      kind: "deleted",
      yclientsRecordId: 1001,
    });
  });

  it("без известного специалиста визит не пишется: связь обязательная", () => {
    expect(buildRecordRow("co", { ...base, staff_id: 999 }, lookups())).toBeNull();
  });

  it("пациента находит по телефону, если идентификатор незнаком", () => {
    const row = buildRecordRow(
      "co",
      { ...base, client: { id: 12345, phone: "+7 (999) 123-45-67" } },
      lookups(),
    );
    expect(row?.kind === "row" && row.data.patientId).toBe("patient-phone");
  });

  it("без пациента визит не пишется", () => {
    expect(buildRecordRow("co", { ...base, client: null }, lookups())).toBeNull();
  });

  it("кабинет и услуга необязательны", () => {
    const row = buildRecordRow(
      "co",
      { ...base, resource_instances: [], services: [] },
      lookups(),
    );
    expect(row?.kind === "row" && row.data.roomId).toBeNull();
    expect(row?.kind === "row" && row.data.primaryServiceId).toBeNull();
  });

  it("неизвестный кабинет не подставляет чужой", () => {
    const row = buildRecordRow("co", { ...base, resource_instances: [{ resource_id: 404 }] }, lookups());
    expect(row?.kind === "row" && row.data.roomId).toBeNull();
  });

  it("повторный разбор той же записи даёт тот же результат", () => {
    const a = buildRecordRow("co", base, lookups());
    const b = buildRecordRow("co", base, lookups());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("кабинет по специалисту, когда YCLIENTS его не прислал", () => {
  /** Запись без ресурса: так их отдаёт YCLIENTS клиники без кабинетов. */
  const noRoom = { ...base, resource_instances: [] };

  it("берётся кабинет по умолчанию у врача", () => {
    // Клиника не ведёт кабинеты в YCLIENTS как ресурсы: в записях их нет, и
    // загрузку кабинетов считать было не из чего.
    const row = buildRecordRow(
      "co",
      noRoom,
      lookups({ defaultRoomByStaffId: new Map([["staff-1", "room-osteo"]]) }),
    );
    expect(row?.kind).toBe("row");
    if (row?.kind !== "row") return;
    expect(row.data.roomId).toBe("room-osteo");
  });

  it("кабинет из записи важнее кабинета по умолчанию", () => {
    const row = buildRecordRow(
      "co",
      base,
      lookups({ defaultRoomByStaffId: new Map([["staff-1", "room-osteo"]]) }),
    );
    if (row?.kind !== "row") return;
    expect(row.data.roomId).toBe("room-1");
  });

  it("без привязки визит остаётся без кабинета", () => {
    // Выдумывать кабинет нельзя: придуманная занятость хуже пустого места.
    const row = buildRecordRow("co", noRoom, lookups());
    if (row?.kind !== "row") return;
    expect(row.data.roomId).toBeNull();
  });
});
