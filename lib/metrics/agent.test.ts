import { describe, expect, it } from "vitest";
import {
  agentAutonomy,
  agentReliability,
  closedByAgent,
  escalationBreakdown,
  median,
  percentile,
  type AgentRunRow,
  type AutonomyDialog,
  agentAssist,
  type AssistDialog,
} from "./agent";

const T = (iso: string) => new Date(iso);
const BASE = "2026-09-03T10:00:00+03:00";

const run = (over: Partial<AgentRunRow> = {}): AgentRunRow => ({
  id: "r1",
  conversationId: "c1",
  outcome: "OK",
  triggeredAt: T(BASE),
  latencyMs: 1000,
  retryOf: null,
  ...over,
});

describe("медиана и перцентили", () => {
  /**
   * Пустой набор — не ноль. «Латентность 0 мс» это утверждение, которого мы не
   * делали; отсутствие значения показывается как отсутствие.
   */
  it("пустой набор даёт null, а не ноль", () => {
    expect(median([])).toBeNull();
    expect(percentile([], 95)).toBeNull();
  });

  it("один элемент — он сам", () => {
    expect(median([700])).toBe(700);
    expect(percentile([700], 95)).toBe(700);
  });

  it("нечётное количество — средний элемент", () => {
    expect(median([300, 100, 200])).toBe(200);
  });

  it("чётное количество — между двумя средними, а не один из них", () => {
    expect(median([100, 200, 300, 400])).toBe(250);
  });

  it("порядок на входе не важен", () => {
    expect(median([400, 100, 300, 200])).toBe(250);
  });

  it("95-й перцентиль тянется к верхнему краю", () => {
    // Значения 1..100: позиция 99 × 0,95 = 94,05, то есть чуть выше 95-го
    // элемента. Линейная интерполяция даёт 95 — так же считает большинство
    // инструментов, и это важнее «красивого» числа.
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 100)).toBe(100);
  });
});

describe("надёжность агента", () => {
  it("эскалации и молчание не считаются отказами", () => {
    // Часть тем агенту запрещена (§6) — передача человеку это штатная работа,
    // а не брак. Молчание при перехвате — тем более.
    const r = agentReliability([
      run({ outcome: "OK" }),
      run({ outcome: "ESCALATED", latencyMs: null }),
      run({ outcome: "SUPPRESSED", latencyMs: null }),
    ]);
    expect(r.attempts).toBe(1);
    expect(r.okRate).toBe(1);
    expect(r.suppressed).toBe(1);
  });

  it("считает доли исходов", () => {
    const r = agentReliability([
      run({ outcome: "OK" }),
      run({ outcome: "OK" }),
      run({ outcome: "TIMEOUT", latencyMs: null }),
      run({ outcome: "PROVIDER_ERROR", latencyMs: null }),
    ]);
    expect(r.attempts).toBe(4);
    expect(r.okRate).toBe(0.5);
    expect(r.timeoutRate).toBe(0.25);
    expect(r.providerErrorRate).toBe(0.25);
  });

  it("без попыток доли пустые, а не нулевые", () => {
    const r = agentReliability([run({ outcome: "SUPPRESSED", latencyMs: null })]);
    expect(r.attempts).toBe(0);
    expect(r.okRate).toBeNull();
    expect(r.p50).toBeNull();
  });

  it("считает ответы, спасённые повтором", () => {
    // Первая попытка сорвалась по времени, вторая ответила: без повтора
    // пациент получил бы «передаю администратору».
    const r = agentReliability([
      run({ id: "a", outcome: "TIMEOUT", latencyMs: null }),
      run({ id: "b", outcome: "OK", retryOf: "a" }),
    ]);
    expect(r.savedByRetry).toBe(1);
  });

  it("латентность считает только по удачным попыткам", () => {
    const r = agentReliability([
      run({ outcome: "OK", latencyMs: 1000 }),
      run({ outcome: "OK", latencyMs: 3000 }),
      // У таймаута латентность равна сроку ожидания и медиану бы испортила.
      run({ outcome: "TIMEOUT", latencyMs: 12000 }),
    ]);
    expect(r.p50).toBe(2000);
  });
});

describe("закрыл ли агент разговор сам", () => {
  const dialog = (over: Partial<AutonomyDialog> = {}): AutonomyDialog => ({
    conversationId: "c1",
    agentRepliedAt: T(BASE),
    staffRepliedAt: null,
    escalatedAt: null,
    patientRepliedAt: null,
    ...over,
  });

  it("никто не вмешался — закрыл", () => {
    expect(closedByAgent(dialog())).toBe(true);
  });

  it("сотрудник ответил в сутки — не закрыл", () => {
    expect(closedByAgent(dialog({ staffRepliedAt: T("2026-09-03T20:00:00+03:00") }))).toBe(false);
  });

  it("сотрудник ответил позже суток — это уже другой разговор", () => {
    expect(closedByAgent(dialog({ staffRepliedAt: T("2026-09-05T10:00:00+03:00") }))).toBe(true);
  });

  it("эскалация в сутки — не закрыл", () => {
    expect(closedByAgent(dialog({ escalatedAt: T("2026-09-03T11:00:00+03:00") }))).toBe(false);
  });

  /**
   * Главное отличие от наивной метрики: агент, ответивший невпопад и
   * вызвавший уточнение, успешным не считается.
   */
  it("пациент переспросил в два часа — тема не закрыта", () => {
    expect(closedByAgent(dialog({ patientRepliedAt: T("2026-09-03T11:00:00+03:00") }))).toBe(false);
  });

  it("пациент написал через три часа — это новое обращение", () => {
    expect(closedByAgent(dialog({ patientRepliedAt: T("2026-09-03T13:30:00+03:00") }))).toBe(true);
  });

  it("вмешательство ДО ответа агента не в счёт", () => {
    // Администратор писал утром, агент ответил в 10:00 — это не «перехват».
    expect(closedByAgent(dialog({ staffRepliedAt: T("2026-09-03T08:00:00+03:00") }))).toBe(true);
  });

  it("доля пустая, когда агент в периоде не отвечал", () => {
    const a = agentAutonomy([]);
    expect(a.total).toBe(0);
    expect(a.rate).toBeNull();
  });

  it("считает долю закрытых", () => {
    const a = agentAutonomy([
      dialog(),
      dialog({ conversationId: "c2", staffRepliedAt: T("2026-09-03T12:00:00+03:00") }),
    ]);
    expect(a.closedByAgent).toBe(1);
    expect(a.wentToHuman).toBe(1);
    expect(a.rate).toBe(0.5);
  });
});

describe("эскалации по поводам", () => {
  it("считает количество, долю, медиану разбора и неразобранные", () => {
    const rows = escalationBreakdown([
      { reason: "MEDICAL_QUESTION", createdAt: T(BASE), acknowledgedAt: T("2026-09-03T10:10:00+03:00") },
      { reason: "MEDICAL_QUESTION", createdAt: T(BASE), acknowledgedAt: T("2026-09-03T10:30:00+03:00") },
      { reason: "MISUNDERSTOOD", createdAt: T(BASE), acknowledgedAt: null },
    ]);
    const medical = rows.find((r) => r.reason === "MEDICAL_QUESTION")!;
    expect(medical.count).toBe(2);
    expect(medical.share).toBeCloseTo(2 / 3);
    expect(medical.medianToAckMs).toBe(20 * 60 * 1000);

    const misunderstood = rows.find((r) => r.reason === "MISUNDERSTOOD")!;
    expect(misunderstood.unresolved).toBe(1);
    expect(misunderstood.medianToAckMs).toBeNull();
  });

  it("разбор раньше создания отбрасывается как рассинхрон часов", () => {
    const [row] = escalationBreakdown([
      { reason: "KEYWORD", createdAt: T("2026-09-03T10:00:00+03:00"), acknowledgedAt: T("2026-09-03T09:00:00+03:00") },
    ]);
    expect(row.medianToAckMs).toBeNull();
  });
});

describe("агент оформил заявку", () => {
  const t = (iso: string) => new Date(iso);
  const dialog = (over: Partial<AssistDialog> = {}): AssistDialog => ({
    conversationId: "c1",
    agentReplied: true,
    intakeAt: t("2026-09-01T10:00:00+03:00"),
    handedOverAt: t("2026-09-01T10:05:00+03:00"),
    bookedAt: t("2026-09-02T09:00:00+03:00"),
    ...over,
  });

  it("все три условия — заявка оформлена и стала записью", () => {
    const a = agentAssist([dialog()]);
    expect(a.prepared).toBe(1);
    expect(a.booked).toBe(1);
    expect(a.bookRate).toBe(1);
  });

  /**
   * Без данных для записи это просто разговор. «Оформил» не должно означать
   * «пациент что-то написал».
   */
  it("без данных для записи заявки нет", () => {
    expect(agentAssist([dialog({ intakeAt: null })]).prepared).toBe(0);
  });

  it("без передачи человеку заявки нет", () => {
    expect(agentAssist([dialog({ handedOverAt: null })]).prepared).toBe(0);
  });

  it("разговор без агента в знаменатель не идёт", () => {
    const a = agentAssist([dialog({ agentReplied: false })]);
    expect(a.total).toBe(0);
    expect(a.prepareRate).toBeNull();
  });

  it("запись позже недели заслугой заявки не считается", () => {
    const a = agentAssist([dialog({ bookedAt: t("2026-09-20T09:00:00+03:00") })]);
    expect(a.prepared).toBe(1);
    expect(a.booked).toBe(0);
  });

  it("запись ДО передачи заявке не засчитывается", () => {
    const a = agentAssist([dialog({ bookedAt: t("2026-08-30T09:00:00+03:00") })]);
    expect(a.booked).toBe(0);
  });

  it("пусто — прочерки, а не нули", () => {
    const a = agentAssist([]);
    expect(a.prepareRate).toBeNull();
    expect(a.bookRate).toBeNull();
  });
});
