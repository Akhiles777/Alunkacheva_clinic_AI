import type { SourceConfidence } from "./source-attribution";

/**
 * Откуда пришёл человек — источник его ПЕРВОГО обращения.
 *
 * В карточке стояло «Первое обращение: 6 сентября, источник: —» — при том что
 * визиты того же пациента подписаны «WhatsApp · из переписки». Автоатрибуция
 * дошла до визитов (`lib/metrics/source-attribution.ts`) и не дошла до самого
 * человека, хотя ответ лежит на поверхности: первое, что мы о нём знаем, —
 * это сообщение в конкретном канале или занесённый звонок.
 *
 * Здесь другой вопрос, чем у визита, и потому другая функция (§8, «одна
 * метрика — одна функция»). У визита спрашивают «какой разговор к нему
 * привёл» — там окно в две недели вокруг создания записи. У человека
 * спрашивают «откуда он взялся» — там нет никакого окна, есть самое раннее
 * касание за всю историю.
 *
 * Чего мы не делаем: не подставляем «звонок» там, где касаний нет вовсе.
 * Отсутствие переписки не доказывает звонок — человек мог прийти с улицы или
 * по рекомендации. Такая карточка остаётся с неизвестным источником.
 */

export interface ContactTouch {
  at: Date;
  sourceId: string;
  /** Переписка или занесённый звонок. Объясняет вывод, на выбор не влияет. */
  kind: "message" | "call";
}

export interface PatientSourceInput {
  current: { sourceId: string | null; confidence: SourceConfidence };
  touches: ContactTouch[];
}

export interface PatientSourceResult {
  sourceId: string | null;
  confidence: SourceConfidence;
  changed: boolean;
  /** Касание, на котором основан вывод: его показываем как основание. */
  basis: ContactTouch | null;
}

export function firstContactSource(input: PatientSourceInput): PatientSourceResult {
  const keep = (): PatientSourceResult => ({
    sourceId: input.current.sourceId,
    confidence: input.current.confidence,
    changed: false,
    basis: null,
  });

  /**
   * Уже проставленный источник не переписываем НИКОГДА — ни ручной, ни свой
   * прежний. Ручной неприкосновенен по решению заказчика: администратор
   * говорил с человеком и знает больше нас. Свой прежний не трогаем из другого
   * соображения: пересчёт, меняющий вчерашний вывод на сегодняшний, ставит под
   * сомнение оба, а пользы от смены нет — первое обращение уже случилось и
   * другим не станет.
   */
  if (input.current.sourceId !== null) return keep();

  if (input.touches.length === 0) return keep();

  /**
   * Самое раннее касание. При совпадении времени — меньший идентификатор
   * источника: результат обязан быть одним и тем же при каждом пересчёте, а
   * порядок строк база не обещает.
   */
  const first = [...input.touches].sort(
    (a, b) => a.at.getTime() - b.at.getTime() || a.sourceId.localeCompare(b.sourceId),
  )[0];

  return { sourceId: first.sourceId, confidence: "DERIVED", changed: true, basis: first };
}
