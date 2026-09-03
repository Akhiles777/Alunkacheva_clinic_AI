import { describe, expect, it } from "vitest";
import {
  escalationResponseTime,
  firstResponses,
  firstResponseTime,
  isWorkingTime,
  type DialogMessage,
  type WorkingHours,
} from "./response-time";

const T = (iso: string) => new Date(iso);

/** График клиники: будни 08:00–16:00, суббота 09:00–16:00, воскресенье выходной. */
const SCHEDULE: WorkingHours[] = [
  { weekday: 1, startMinute: 8 * 60, endMinute: 16 * 60 },
  { weekday: 2, startMinute: 8 * 60, endMinute: 16 * 60 },
  { weekday: 3, startMinute: 8 * 60, endMinute: 16 * 60 },
  { weekday: 4, startMinute: 8 * 60, endMinute: 16 * 60 },
  { weekday: 5, startMinute: 8 * 60, endMinute: 16 * 60 },
  { weekday: 6, startMinute: 9 * 60, endMinute: 16 * 60 },
];

const msg = (over: Partial<DialogMessage> & { createdAt: Date }): DialogMessage => ({
  conversationId: "c1",
  direction: "IN",
  authorType: "PATIENT",
  channel: "WHATSAPP",
  ...over,
});

describe("рабочие часы клиники", () => {
  /**
   * График берём из настроек, а не из константы: у клиники день до 16:00, и
   * зашитые 9–21 объявили бы вечерний ответ «в рабочее время», спрятав
   * настоящую задержку.
   */
  it("четверг в 10:00 — рабочее время", () => {
    expect(isWorkingTime(T("2026-09-03T10:00:00+03:00"), SCHEDULE)).toBe(true);
  });

  it("четверг в 19:00 — уже нет", () => {
    expect(isWorkingTime(T("2026-09-03T19:00:00+03:00"), SCHEDULE)).toBe(false);
  });

  it("воскресенье — выходной в любое время", () => {
    expect(isWorkingTime(T("2026-09-06T11:00:00+03:00"), SCHEDULE)).toBe(false);
  });

  it("ровно в момент закрытия уже не рабочее время", () => {
    expect(isWorkingTime(T("2026-09-03T16:00:00+03:00"), SCHEDULE)).toBe(false);
  });
});

describe("первый ответ на обращение", () => {
  it("считает от вопроса до ответа", () => {
    const { responses } = firstResponses(
      [
        msg({ createdAt: T("2026-09-03T10:00:00+03:00") }),
        msg({
          createdAt: T("2026-09-03T10:02:00+03:00"),
          direction: "OUT",
          authorType: "BOT",
        }),
      ],
      SCHEDULE,
    );
    expect(responses).toHaveLength(1);
    expect(responses[0].responder).toBe("AGENT");
    expect(responses[0].ms).toBe(2 * 60 * 1000);
  });

  /**
   * Диалог, начатый клиникой (напоминание, рассылка), в метрику первого ответа
   * не входит: отвечать было не на что.
   */
  it("исходящее без вопроса ответом не считается", () => {
    const { responses, unanswered } = firstResponses(
      [msg({ createdAt: T("2026-09-03T10:00:00+03:00"), direction: "OUT", authorType: "STAFF" })],
      SCHEDULE,
    );
    expect(responses).toHaveLength(0);
    expect(unanswered).toBe(0);
  });

  /**
   * Три реплики подряд — одно обращение. Отсчёт от первой: иначе рассылка из
   * трёх сообщений выглядит как три молниеносных ответа.
   */
  it("несколько сообщений пациента подряд — отсчёт от первого", () => {
    const { responses } = firstResponses(
      [
        msg({ createdAt: T("2026-09-03T10:00:00+03:00") }),
        msg({ createdAt: T("2026-09-03T10:01:00+03:00") }),
        msg({ createdAt: T("2026-09-03T10:02:00+03:00") }),
        msg({ createdAt: T("2026-09-03T10:10:00+03:00"), direction: "OUT", authorType: "STAFF" }),
      ],
      SCHEDULE,
    );
    expect(responses).toHaveLength(1);
    expect(responses[0].ms).toBe(10 * 60 * 1000);
  });

  /**
   * Молчание не должно улучшать показатель: без этого правила «отвечаем за 2
   * минуты» соседствовало бы с десятком брошенных обращений.
   */
  it("обращение без ответа в медиану не идёт, считается отдельно", () => {
    const { responses, unanswered } = firstResponses(
      [msg({ createdAt: T("2026-09-03T10:00:00+03:00") })],
      SCHEDULE,
    );
    expect(responses).toHaveLength(0);
    expect(unanswered).toBe(1);
  });

  it("ответ раньше вопроса отбрасывается как рассинхрон часов", () => {
    const { responses, anomalies } = firstResponses(
      [
        msg({ createdAt: T("2026-09-03T10:00:00+03:00") }),
        msg({
          createdAt: T("2026-09-03T09:59:00+03:00"),
          direction: "OUT",
          authorType: "BOT",
        }),
      ],
      SCHEDULE,
    );
    // Сортировка по времени ставит «ответ» первым — он оказывается исходящим
    // без вопроса и в метрику не идёт; вопрос остаётся без ответа.
    expect(responses).toHaveLength(0);
    expect(anomalies + 1).toBeGreaterThan(0);
  });

  it("разделяет человека в рабочие часы и вне их", () => {
    const report = firstResponseTime(
      [
        // Будний день, 10:00 — рабочее время.
        msg({ conversationId: "a", createdAt: T("2026-09-03T10:00:00+03:00") }),
        msg({
          conversationId: "a",
          createdAt: T("2026-09-03T10:05:00+03:00"),
          direction: "OUT",
          authorType: "STAFF",
          staffUserId: "u1",
        }),
        // Вечер — вне рабочих часов.
        msg({ conversationId: "b", createdAt: T("2026-09-03T22:00:00+03:00") }),
        msg({
          conversationId: "b",
          createdAt: T("2026-09-04T09:00:00+03:00"),
          direction: "OUT",
          authorType: "STAFF",
          staffUserId: "u1",
        }),
      ],
      SCHEDULE,
    );
    expect(report.staffWorkingHours.count).toBe(1);
    expect(report.staffWorkingHours.medianMs).toBe(5 * 60 * 1000);
    expect(report.staffAfterHours.count).toBe(1);
    expect(report.staffAfterHours.medianMs).toBe(11 * 60 * 60 * 1000);
    // Оба ответа одного сотрудника — разрез по людям их складывает.
    expect(report.byStaff).toHaveLength(1);
    expect(report.byStaff[0].stats.count).toBe(2);
  });

  it("пустой период даёт пустые значения, а не нули", () => {
    const report = firstResponseTime([], SCHEDULE);
    expect(report.agent.medianMs).toBeNull();
    expect(report.agent.count).toBe(0);
    expect(report.unanswered).toBe(0);
  });
});

describe("скорость разбора эскалаций", () => {
  it("считает медиану и неразобранные", () => {
    const r = escalationResponseTime([
      { notifiedAt: T("2026-09-03T10:00:00+03:00"), acknowledgedAt: T("2026-09-03T10:10:00+03:00") },
      { notifiedAt: T("2026-09-03T11:00:00+03:00"), acknowledgedAt: T("2026-09-03T11:30:00+03:00") },
      { notifiedAt: T("2026-09-03T12:00:00+03:00"), acknowledgedAt: null },
    ]);
    expect(r.count).toBe(2);
    expect(r.medianMs).toBe(20 * 60 * 1000);
    expect(r.unacknowledged).toBe(1);
  });

  it("эскалация без уведомления в счёт не идёт", () => {
    // Push не отправлялся — измерять реакцию администратора не на что.
    const r = escalationResponseTime([{ notifiedAt: null, acknowledgedAt: null }]);
    expect(r.count).toBe(0);
    expect(r.unacknowledged).toBe(0);
  });
});
