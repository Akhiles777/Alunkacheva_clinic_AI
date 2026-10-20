/**
 * Какие услуги YCLIENTS считаются услугами акции.
 *
 * «Школьный ресурс 6+» в YCLIENTS — составная услуга (6 300 ₽), а её части
 * заведены отдельными строками «Школьный ресурс» (3 210, 800, 2 290 ₽) и стоят
 * в записях разных специалистов. Клиника может завести ещё одну часть или
 * переименовать старую — и визит молча выпадет из акции, а школа не получит
 * бонус. Поэтому состав складывается из двух источников (решение заказчика,
 * 20 октября: «всё, что начинается с Школьный, мы должны улавливать»):
 *
 *   — номера, выбранные на экране акции (`serviceIds`);
 *   — услуги, чьё название начинается с ключевого слова (`serviceKeywords`,
 *     по умолчанию «школьн»), кроме исключённых руками (`excludedServiceIds`).
 *
 * Пойманное по названию показывается на экране отдельно — «поймана по
 * названию», с кнопкой исключить: человек видит, что система взяла сама.
 */

export interface CatalogService {
  yclientsServiceId: number | null;
  title: string;
  isActive: boolean;
}

export interface PromoServiceConfig {
  serviceIds: number[];
  serviceKeywords: string[];
  excludedServiceIds: number[];
  /** Названия выбранных услуг на момент выбора: { "32377789": "Школьный ресурс 6+" }. */
  serviceSnapshot: Record<string, string>;
}

export type PromoServiceWarning =
  | { kind: "renamed"; yclientsServiceId: number; was: string; now: string }
  | { kind: "missing"; yclientsServiceId: number; was: string | null }
  | { kind: "inactive"; yclientsServiceId: number; title: string }
  /**
   * Выбрана руками, а название на ключевые слова не похоже: «Диагностика/
   * консультация на БОС-терапию» за 1 000 ₽. Обычные приёмы такой услуги
   * засчитываются визитами акции, и школа получает бонус за ребёнка, пришедшего
   * не на акцию. Так она и попала на боевую акцию — её поставил прежний код по
   * позиции состава, а не человек. Сами не убираем: выбор услуг — решение
   * администратора, но молча такое стоять не должно.
   */
  | { kind: "unlike"; yclientsServiceId: number; title: string };

export interface PromoServiceSet {
  /** Все номера, визиты по которым засчитываются. */
  ids: number[];
  /** Выбраны руками. */
  chosen: number[];
  /** Пойманы по названию (и не выбраны руками). */
  byKeyword: number[];
  /** Подходят по названию, но исключены руками. */
  excluded: number[];
  warnings: PromoServiceWarning[];
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/^[\s«"'„“(]+/u, "")
    .trim();

/** Название начинается с одного из ключевых слов («Школьный ресурс 6+» → «школьн»). */
export function titleMatches(title: string, keywords: string[]): boolean {
  const t = norm(title);
  return keywords.map(norm).some((k) => k.length >= 3 && t.startsWith(k));
}

export function promoServiceSet(config: PromoServiceConfig, catalog: CatalogService[]): PromoServiceSet {
  const byId = new Map<number, CatalogService>();
  for (const s of catalog) if (s.yclientsServiceId != null) byId.set(s.yclientsServiceId, s);

  const chosen = [...new Set(config.serviceIds)];
  const excludedSet = new Set(config.excludedServiceIds);
  const matching = catalog
    .filter((s) => s.yclientsServiceId != null && s.isActive && titleMatches(s.title, config.serviceKeywords))
    .map((s) => s.yclientsServiceId!);
  const byKeyword = matching.filter((id) => !chosen.includes(id) && !excludedSet.has(id));
  const excluded = matching.filter((id) => excludedSet.has(id) && !chosen.includes(id));

  const warnings: PromoServiceWarning[] = [];
  for (const id of chosen) {
    const s = byId.get(id);
    const was = config.serviceSnapshot[String(id)] ?? null;
    if (!s) {
      warnings.push({ kind: "missing", yclientsServiceId: id, was });
      continue;
    }
    if (!s.isActive) warnings.push({ kind: "inactive", yclientsServiceId: id, title: s.title });
    if (config.serviceKeywords.length && !titleMatches(s.title, config.serviceKeywords) && !(was && titleMatches(was, config.serviceKeywords)))
      warnings.push({ kind: "unlike", yclientsServiceId: id, title: s.title });
    if (was && norm(was) !== norm(s.title)) warnings.push({ kind: "renamed", yclientsServiceId: id, was, now: s.title });
  }

  return {
    ids: [...new Set([...chosen, ...byKeyword])].sort((a, b) => a - b),
    chosen,
    byKeyword,
    excluded,
    warnings,
  };
}

/** Снимок названий выбранных услуг — сохраняется вместе с выбором. */
export function snapshotOf(ids: number[], catalog: CatalogService[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of catalog) {
    if (s.yclientsServiceId != null && ids.includes(s.yclientsServiceId)) out[String(s.yclientsServiceId)] = s.title;
  }
  return out;
}

/** Снимок из базы: JSON, которому нельзя верить на слово. */
export function snapshotFrom(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  return out;
}
