import { describe, expect, it } from "vitest";
import {
  attributeSource,
  inWindow,
  LOOKAHEAD_MS,
  LOOKBACK_DAYS,
  type AttributionInput,
  type DialogTouch,
} from "./source-attribution";

const T = (iso: string) => new Date(iso);
const CREATED = T("2026-09-03T12:00:00+03:00");

const touch = (over: Partial<DialogTouch> = {}): DialogTouch => ({
  conversationId: "conv-wa",
  sourceId: "src-whatsapp",
  messageAt: T("2026-09-03T11:00:00+03:00"),
  ...over,
});

const input = (over: Partial<AttributionInput> = {}): AttributionInput => ({
  createdAt: CREATED,
  current: { sourceId: null, confidence: "UNKNOWN" },
  touches: [touch()],
  ...over,
});

describe("окно поиска разговора", () => {
  it("сообщение за час до записи — внутри", () => {
    expect(inWindow(CREATED, T("2026-09-03T11:00:00+03:00"))).toBe(true);
  });

  /**
   * Час вперёд нужен потому, что администратор нередко заводит запись прямо во
   * время переписки, и по часам она оказывается на минуту раньше последнего
   * сообщения пациента.
   */
  it("сообщение через полчаса после записи — тоже внутри", () => {
    expect(inWindow(CREATED, T("2026-09-03T12:30:00+03:00"))).toBe(true);
  });

  it("ровно на границе окна назад — внутри", () => {
    const edge = new Date(CREATED.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    expect(inWindow(CREATED, edge)).toBe(true);
  });

  it("на секунду раньше границы — уже нет", () => {
    const past = new Date(CREATED.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000 - 1000);
    expect(inWindow(CREATED, past)).toBe(false);
  });

  it("ровно на границе вперёд — внутри, дальше — нет", () => {
    expect(inWindow(CREATED, new Date(CREATED.getTime() + LOOKAHEAD_MS))).toBe(true);
    expect(inWindow(CREATED, new Date(CREATED.getTime() + LOOKAHEAD_MS + 1000))).toBe(false);
  });
});

describe("вывод источника", () => {
  it("один диалог рядом — источник его канала", () => {
    const r = attributeSource(input());
    expect(r.sourceId).toBe("src-whatsapp");
    expect(r.confidence).toBe("DERIVED");
    expect(r.changed).toBe(true);
    expect(r.conversationId).toBe("conv-wa");
  });

  it("несколько диалогов — тот, где писали ближе к записи", () => {
    const r = attributeSource(
      input({
        touches: [
          touch({ conversationId: "conv-tg", sourceId: "src-telegram", messageAt: T("2026-08-25T10:00:00+03:00") }),
          touch({ conversationId: "conv-wa", sourceId: "src-whatsapp", messageAt: T("2026-09-03T11:50:00+03:00") }),
        ],
      }),
    );
    expect(r.sourceId).toBe("src-whatsapp");
  });

  /**
   * Отсутствие переписки не доказывает звонок: человек мог прийти по
   * рекомендации, с улицы, из старой записи. Подставлять «звонок» значило бы
   * выдать догадку за факт.
   */
  it("диалогов рядом нет — остаётся «неизвестен», а не «звонок»", () => {
    const r = attributeSource(input({ touches: [] }));
    expect(r.sourceId).toBeNull();
    expect(r.confidence).toBe("UNKNOWN");
  });

  it("диалог есть, но давно — за окном, источник неизвестен", () => {
    const r = attributeSource(
      input({ touches: [touch({ messageAt: T("2026-07-01T10:00:00+03:00") })] }),
    );
    expect(r.sourceId).toBeNull();
    expect(r.confidence).toBe("UNKNOWN");
  });

  /**
   * Главная защита: администратор, проставивший источник руками, знает больше
   * нас — он говорил с человеком. Пересчёт, переписывающий такую отметку,
   * обесценивает саму возможность её поставить.
   */
  it("ручной источник пересчёт не трогает НИКОГДА", () => {
    const r = attributeSource(
      input({ current: { sourceId: "src-referral", confidence: "MANUAL" } }),
    );
    expect(r.sourceId).toBe("src-referral");
    expect(r.confidence).toBe("MANUAL");
    expect(r.changed).toBe(false);
  });

  it("ручной источник не трогает, даже если диалог рядом другой", () => {
    const r = attributeSource(
      input({
        current: { sourceId: "src-offline", confidence: "MANUAL" },
        touches: [touch({ sourceId: "src-whatsapp" })],
      }),
    );
    expect(r.sourceId).toBe("src-offline");
    expect(r.changed).toBe(false);
  });
});

describe("идемпотентность", () => {
  it("повторный пересчёт на тех же данных ничего не меняет", () => {
    const first = attributeSource(input());
    const second = attributeSource(
      input({ current: { sourceId: first.sourceId, confidence: first.confidence } }),
    );
    expect(second.sourceId).toBe(first.sourceId);
    expect(second.confidence).toBe(first.confidence);
    expect(second.changed).toBe(false);
  });

  it("повторный пересчёт «неизвестного» тоже ничего не меняет", () => {
    const r = attributeSource(input({ touches: [] }));
    const again = attributeSource(
      input({ touches: [], current: { sourceId: r.sourceId, confidence: r.confidence } }),
    );
    expect(again.changed).toBe(false);
  });

  it("при равном расстоянии выбор не зависит от порядка строк", () => {
    const a = touch({ conversationId: "conv-a", sourceId: "src-a", messageAt: T("2026-09-03T11:00:00+03:00") });
    const b = touch({ conversationId: "conv-b", sourceId: "src-b", messageAt: T("2026-09-03T13:00:00+03:00") });
    // Оба ровно в часе от создания записи: порядок не должен решать.
    expect(attributeSource(input({ touches: [a, b] })).sourceId).toBe(
      attributeSource(input({ touches: [b, a] })).sourceId,
    );
  });
});
