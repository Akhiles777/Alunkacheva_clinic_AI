import { describe, expect, it } from "vitest";
import { apiDate, hasNextPage, monthWindows, MAX_PAGES, PAGE_SIZE } from "./paging";

/**
 * Начальная выгрузка обязана быть полной (§5). Прежняя тянула одну страницу и
 * один диапазон по умолчанию — у клиники с тысячей клиентов приезжала первая
 * сотня, а метрики «новые пациенты» и «первичный/повторный» врали.
 */
describe("hasNextPage", () => {
  const base = { pageSize: PAGE_SIZE, page: 1, fetchedSoFar: PAGE_SIZE };

  it("продолжает, пока страница приходит полной", () => {
    expect(hasNextPage({ ...base, received: PAGE_SIZE })).toBe(true);
  });

  it("останавливается на неполной странице", () => {
    expect(hasNextPage({ ...base, received: PAGE_SIZE - 1 })).toBe(false);
  });

  it("останавливается на пустой странице", () => {
    expect(hasNextPage({ ...base, received: 0 })).toBe(false);
  });

  it("учитывает total_count, если он есть", () => {
    expect(
      hasNextPage({ ...base, received: PAGE_SIZE, fetchedSoFar: 200, totalCount: 200 }),
    ).toBe(false);
    expect(
      hasNextPage({ ...base, received: PAGE_SIZE, fetchedSoFar: 200, totalCount: 640 }),
    ).toBe(true);
  });

  it("не зацикливается, если сервер всегда отдаёт полную страницу", () => {
    expect(hasNextPage({ ...base, received: PAGE_SIZE, page: MAX_PAGES })).toBe(false);
  });
});

describe("monthWindows", () => {
  it("режет период по календарным месяцам", () => {
    const w = monthWindows(new Date("2026-01-15T00:00:00Z"), new Date("2026-03-10T00:00:00Z"));
    expect(w.map((x) => [apiDate(x.from), apiDate(x.to)])).toEqual([
      ["2026-01-15", "2026-02-01"],
      ["2026-02-01", "2026-03-01"],
      ["2026-03-01", "2026-03-10"],
    ]);
  });

  it("окна не перекрываются: конец одного равен началу следующего", () => {
    const w = monthWindows(new Date("2025-11-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"));
    for (let i = 1; i < w.length; i++) {
      expect(w[i].from.getTime()).toBe(w[i - 1].to.getTime());
    }
  });

  it("период внутри одного месяца — одно окно", () => {
    const w = monthWindows(new Date("2026-03-05T00:00:00Z"), new Date("2026-03-20T00:00:00Z"));
    expect(w).toHaveLength(1);
  });

  it("пустой и перевёрнутый период не дают окон", () => {
    expect(monthWindows(new Date("2026-03-05Z"), new Date("2026-03-05Z"))).toEqual([]);
    expect(monthWindows(new Date("2026-04-01Z"), new Date("2026-03-01Z"))).toEqual([]);
  });

  it("год разбивается на двенадцать окон", () => {
    expect(monthWindows(new Date("2025-01-01Z"), new Date("2026-01-01Z"))).toHaveLength(12);
  });
});
