import { describe, expect, it } from "vitest";
import { promoServiceSet, snapshotOf, titleMatches, type CatalogService } from "./promo-services";

/** Как в боевом справочнике клиники (диагностика 20 октября). */
const CATALOG: CatalogService[] = [
  { yclientsServiceId: 32377789, title: "Школьный ресурс 6+", isActive: true },
  { yclientsServiceId: 32378309, title: "Школьный ресурс", isActive: true },
  { yclientsServiceId: 32378364, title: "Школьный ресурс", isActive: true },
  { yclientsServiceId: 32378554, title: "Школьный ресурс", isActive: true },
  { yclientsServiceId: 29041074, title: 'Инфузия "Био-Ресурс"', isActive: true },
  { yclientsServiceId: 29041455, title: 'Инфузия "Абсолютный ресурс"', isActive: true },
  { yclientsServiceId: 13778680, title: "Детский прием до 10 л - остеопатия", isActive: true },
];

const base = { serviceIds: [] as number[], serviceKeywords: ["школьн"], excludedServiceIds: [] as number[], serviceSnapshot: {} };

describe("услуги акции", () => {
  it("«Школьный ресурс 6+» и все его части ловятся по названию, инфузии «…ресурс» — нет", () => {
    const set = promoServiceSet(base, CATALOG);
    expect(set.ids).toEqual([32377789, 32378309, 32378364, 32378554]);
    expect(set.byKeyword).toHaveLength(4);
    expect(set.ids).not.toContain(29041074);
  });

  it("выбранная руками услуга входит, даже если название другое", () => {
    const set = promoServiceSet({ ...base, serviceIds: [13778680] }, CATALOG);
    expect(set.ids).toContain(13778680);
    expect(set.chosen).toEqual([13778680]);
  });

  it("исключённая руками часть не входит и видна отдельно — сама обратно не добавляется", () => {
    const set = promoServiceSet({ ...base, excludedServiceIds: [32378364] }, CATALOG);
    expect(set.ids).not.toContain(32378364);
    expect(set.excluded).toEqual([32378364]);
  });

  it("выключенная услуга по названию не ловится; выбранная выключенная — предупреждение", () => {
    const catalog = CATALOG.map((s) => (s.yclientsServiceId === 32378554 ? { ...s, isActive: false } : s));
    expect(promoServiceSet(base, catalog).ids).not.toContain(32378554);
    const set = promoServiceSet({ ...base, serviceIds: [32378554] }, catalog);
    expect(set.warnings).toContainEqual({ kind: "inactive", yclientsServiceId: 32378554, title: "Школьный ресурс" });
  });

  it("переименование и удаление выбранной услуги — предупреждение, а не тишина", () => {
    const snapshot = snapshotOf([32377789], CATALOG);
    const renamed = CATALOG.map((s) => (s.yclientsServiceId === 32377789 ? { ...s, title: "Чек-ап школьника" } : s));
    expect(promoServiceSet({ ...base, serviceIds: [32377789], serviceSnapshot: snapshot }, renamed).warnings).toContainEqual({
      kind: "renamed",
      yclientsServiceId: 32377789,
      was: "Школьный ресурс 6+",
      now: "Чек-ап школьника",
    });
    const gone = CATALOG.filter((s) => s.yclientsServiceId !== 32377789);
    expect(promoServiceSet({ ...base, serviceIds: [32377789], serviceSnapshot: snapshot }, gone).warnings[0]).toMatchObject({
      kind: "missing",
      was: "Школьный ресурс 6+",
    });
  });

  it("выбранная руками услуга не про акцию — предупреждение, но из состава не убирается", () => {
    const catalog = [...CATALOG, { yclientsServiceId: 15009373, title: "Диагностика/консультация на БОС-терапию", isActive: true }];
    const set = promoServiceSet({ ...base, serviceIds: [15009373, 32377789] }, catalog);
    expect(set.ids).toContain(15009373);
    expect(set.warnings).toEqual([{ kind: "unlike", yclientsServiceId: 15009373, title: "Диагностика/консультация на БОС-терапию" }]);
    // Переименованная школьная услуга — предупреждение о переименовании, а не «не похожа».
    const renamed = CATALOG.map((s) => (s.yclientsServiceId === 32377789 ? { ...s, title: "Чек-ап школьника" } : s));
    const r = promoServiceSet({ ...base, serviceIds: [32377789], serviceSnapshot: snapshotOf([32377789], CATALOG) }, renamed);
    expect(r.warnings.map((w) => w.kind)).toEqual(["renamed"]);
    // Без ключевых слов сравнивать не с чем — молчим.
    expect(promoServiceSet({ ...base, serviceKeywords: [], serviceIds: [15009373] }, catalog).warnings).toEqual([]);
  });

  it("название сверяется без регистра, «ё» и кавычек", () => {
    expect(titleMatches("«ШКОЛЬНЫЙ ресурс»", ["Школьн"])).toBe(true);
    expect(titleMatches("Предшкольный курс", ["школьн"])).toBe(false);
    expect(titleMatches("Школа", ["шк"])).toBe(false); // слишком короткое слово ничего не ловит
  });
});
