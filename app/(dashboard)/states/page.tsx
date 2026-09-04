import { CabinetCard } from "../_components/cabinet-card";
import { FreeWindows } from "../_components/free-windows";
import { AttentionList, InquiryList } from "../_components/today-lists";
import { notFound } from "next/navigation";
import { getToday, type CabinetNow, type FreeWindowRow } from "@/app/_data/today";
import { AgentSection } from "../owner/agent-section";
import type { AgentStats } from "@/lib/server/agent-stats";
import type { SourceStat } from "@/lib/metrics/types";
import { SourcePicker } from "../_components/visit-source";
import { GapsBlock, type GapsData } from "../settings/assistant/gaps-block";
import { QueueClient, type QueueData } from "../queue/queue-client";
import { CourseEconomicsBlock } from "../_components/course-economics";
import { DossierBody } from "../_components/patient-dossier";
import type { DossierView } from "../patients/actions";
import type { CourseEconomics } from "@/lib/server/course-economics";

/**
 * Витрина граничных состояний — служебный экран визуальной проверки.
 * Фикстуры здесь намеренные: экран показывает, как выглядят пустой день,
 * переполненный день и крупные числа.
 *
 * В рабочей сборке страница закрыта. Она не в меню, но открывается по адресу,
 * и её выдуманные суммы (в том числе средний чек 6140 ₽) заказчик принимал за
 * настоящие показатели клиники. Данные, которые нельзя ни с чем сверить, не
 * должны быть доступны на боевом стенде.
 */
export const metadata = { title: "Состояния" };

const base = getToday();

const EMPTY_CABINETS: CabinetNow[] = base.cabinets.map((c) => ({
  ...c,
  current: null,
  nextFree: { time: "09:00", duration: "весь день", soon: c.id === "room-1" },
}));

const BIG_SUMMARY = {
  revenue: 1486000,
  avgCheck: 6140,
  scheduled: 1248,
  firstVisits: 372,
  now: "13:20",
};


/**
 * Фикстуры раздела «Работа ассистента».
 *
 * Пустые значения здесь — null, а не ноль: именно так их отдаёт расчёт, и
 * именно эту разницу проверяет экран.
 */
const NO_STATS = { medianMs: null, meanMs: null, count: 0 };
const NO_SPEED = {
  agent: NO_STATS,
  staffWorkingHours: NO_STATS,
  staffAfterHours: NO_STATS,
  unanswered: 0,
  anomalies: 0,
  byChannel: [],
  byStaff: [],
};
const NO_RELIABILITY = {
  attempts: 0,
  ok: 0,
  timeout: 0,
  providerError: 0,
  emptyResponse: 0,
  okRate: null,
  timeoutRate: null,
  providerErrorRate: null,
  p50: null,
  p95: null,
  savedByRetry: 0,
  suppressed: 0,
};

const AGENT_EMPTY: AgentStats = {
  waiting: {
    answers: 0,
    medianAgentMs: null,
    medianManualMs: null,
    manualSamples: 0,
    enough: false,
    savedMs: 0,
    perAnswerMs: null,
  },
  assist: { total: 0, prepared: 0, booked: 0, prepareRate: null, bookRate: null },
  logSince: null,
  hasData: false,
  reliability: NO_RELIABILITY,
  autonomy: { total: 0, closedByAgent: 0, wentToHuman: 0, rate: null },
  escalations: [],
  escalationAck: { ...NO_STATS, unacknowledged: 0 },
  responseTime: NO_SPEED,
  savings: { savedMs: 0, byTopic: [], skippedTopics: [], escalations: 0, escalationCostMs: 0 },
};

const AGENT_NO_BASE: AgentStats = {
  waiting: {
    answers: 12,
    medianAgentMs: 9000,
    medianManualMs: null,
    manualSamples: 2,
    enough: false,
    savedMs: 0,
    perAnswerMs: null,
  },
  assist: { total: 40, prepared: 12, booked: 7, prepareRate: 0.3, bookRate: 7 / 12 },
  logSince: new Date("2026-09-04T10:00:00+03:00"),
  hasData: true,
  reliability: {
    ...NO_RELIABILITY,
    attempts: 24,
    ok: 22,
    timeout: 2,
    okRate: 22 / 24,
    timeoutRate: 2 / 24,
    providerErrorRate: 0,
    p50: 2400,
    p95: 9100,
    savedByRetry: 2,
    suppressed: 7,
  },
  autonomy: { total: 31, closedByAgent: 19, wentToHuman: 12, rate: 19 / 31 },
  escalations: [
    { reason: "MEDICAL_QUESTION", count: 7, share: 0.58, medianToAckMs: 11 * 60_000, unresolved: 1 },
    { reason: "MISUNDERSTOOD", count: 5, share: 0.42, medianToAckMs: null, unresolved: 5 },
  ],
  escalationAck: { medianMs: 11 * 60_000, meanMs: 19 * 60_000, count: 6, unacknowledged: 6 },
  responseTime: {
    ...NO_SPEED,
    agent: { medianMs: 2400, meanMs: 3100, count: 22 },
    staffWorkingHours: { medianMs: 7 * 60_000, meanMs: 14 * 60_000, count: 18 },
    staffAfterHours: { medianMs: 9 * 3_600_000, meanMs: 11 * 3_600_000, count: 4 },
    unanswered: 3,
    anomalies: 1,
  },
  // Темы есть, но ручных ответов по ним меньше пяти — считать не по чему.
  savings: {
    savedMs: 0,
    byTopic: [],
    skippedTopics: [
      { topic: "Подготовка к внутривенному капельному введению растворов", closed: 9, samples: 3 },
      { topic: "Парковка", closed: 4, samples: 1 },
    ],
    escalations: 12,
    escalationCostMs: 68 * 60_000,
  },
};

const AGENT_BIG: AgentStats = {
  waiting: {
    answers: 412,
    medianAgentMs: 7000,
    medianManualMs: 41 * 60 * 1000,
    manualSamples: 186,
    enough: true,
    perAnswerMs: 41 * 60 * 1000 - 7000,
    savedMs: (41 * 60 * 1000 - 7000) * 412,
  },
  assist: { total: 412, prepared: 168, booked: 121, prepareRate: 168 / 412, bookRate: 121 / 168 },
  logSince: new Date("2026-06-05T10:00:00+03:00"),
  hasData: true,
  reliability: {
    ...NO_RELIABILITY,
    attempts: 4820,
    ok: 4611,
    timeout: 173,
    providerError: 31,
    emptyResponse: 5,
    okRate: 4611 / 4820,
    timeoutRate: 173 / 4820,
    providerErrorRate: 31 / 4820,
    p50: 2700,
    p95: 11400,
    savedByRetry: 118,
    suppressed: 1204,
  },
  autonomy: { total: 1372, closedByAgent: 1043, wentToHuman: 329, rate: 1043 / 1372 },
  escalations: [
    { reason: "MEDICAL_QUESTION", count: 148, share: 0.45, medianToAckMs: 9 * 60_000, unresolved: 12 },
    { reason: "PATIENT_REQUEST", count: 101, share: 0.31, medianToAckMs: 14 * 60_000, unresolved: 7 },
    { reason: "MISUNDERSTOOD", count: 80, share: 0.24, medianToAckMs: 26 * 60_000, unresolved: 21 },
  ],
  escalationAck: { medianMs: 12 * 60_000, meanMs: 41 * 60_000, count: 289, unacknowledged: 40 },
  responseTime: {
    ...NO_SPEED,
    agent: { medianMs: 2700, meanMs: 3400, count: 4611 },
    staffWorkingHours: { medianMs: 6 * 60_000, meanMs: 21 * 60_000, count: 1284 },
    staffAfterHours: { medianMs: 11 * 3_600_000, meanMs: 13 * 3_600_000, count: 402 },
    unanswered: 96,
    anomalies: 4,
  },
  savings: {
    savedMs: 74 * 3_600_000,
    byTopic: [
      { topic: "Адрес и как добраться", closed: 412, samples: 61, manualMedianMs: 4 * 60_000, savedMs: 27 * 3_600_000 },
      { topic: "Подготовка к приёму остеопата", closed: 318, samples: 44, manualMedianMs: 5 * 60_000, savedMs: 26 * 3_600_000 },
      { topic: "Часы работы", closed: 289, samples: 38, manualMedianMs: 4 * 60_000, savedMs: 21 * 3_600_000 },
    ],
    skippedTopics: [{ topic: "Противопоказания к БОС-терапии", closed: 24, samples: 2 }],
    escalations: 329,
    escalationCostMs: 63 * 3_600_000,
  },
};

const LONG_CABINET: CabinetNow = {
  id: "room-long",
  name: "Кабинет 2 (процедурный)",
  direction: "IV-терапия, забор анализов и инъекции",
  doctor: "Константинопольская-Ржевская А. В.",
  current: {
    proc: "IV-терапия",
    patient: "Константинопольская-Ржевская Аполлинария Владиславовна",
    isFirstVisit: true,
    until: "14:10",
    courseProgress: { index: 9, total: 10 },
  },
  nextFree: { time: "14:10", duration: "1 ч 30 мин", soon: true },
};

const LONG_WINDOWS: FreeWindowRow[] = [
  { id: "lw1", time: "14:10", startMinute: 850, cabName: "Кабинет 2 (процедурный)", direction: "IV-терапия, забор анализов и инъекции", duration: "1 ч 30 мин", soon: true },
  { id: "lw2", time: "16:00", startMinute: 960, cabName: "Кабинет 1", direction: "Остеопатия", duration: "1 ч", soon: false },
];

/**
 * Разрез по источникам на день внедрения: источник известен у двух десятков
 * записей из семисот сорока одной. Строка «неизвестен» — самая большая, и
 * прятать её нельзя.
 */
const SOURCES_MOSTLY_UNKNOWN: SourceStat[] = [
  { code: "whatsapp", title: "WhatsApp", inquiries: 42, booked: 14, share: 1 },
  { code: "instagram", title: "Instagram", inquiries: 9, booked: 4, share: 0.21 },
  { code: "telegram", title: "Telegram", inquiries: 3, booked: 3, share: 0.07 },
  { code: "none", title: "Источник неизвестен", inquiries: 0, booked: 720, share: 0, unknown: true },
];

/** Пробелов нет: эскалаций «нечем ответить» за срок не было вовсе. */
const GAPS_EMPTY: GapsData = { clusters: [], total: 0, withoutQuestion: 0, windowDays: 90 };

/**
 * Боевая картина: один вопрос повторяется, второй — медицинский, а к части
 * эскалаций вопрос не нашёлся. Все три случая должны читаться по-разному.
 */
const GAPS_FULL: GapsData = {
  total: 14,
  withoutQuestion: 3,
  windowDays: 90,
  clusters: [
    {
      key: "адрес-клини",
      title: "подскажите адрес клиники",
      count: 6,
      lastAt: "2026-09-02T09:15:00.000Z",
      reasons: ["MISUNDERSTOOD"],
      medical: false,
      questions: [
        { id: "q1", text: "подскажите адрес клиники", at: "2026-09-02T09:15:00.000Z" },
        { id: "q2", text: "а где вы находитесь, как доехать от вокзала", at: "2026-08-30T14:02:00.000Z" },
      ],
      answers: [
        {
          text: "Мы на Ленина 1, второй этаж, вход со двора. Парковка есть перед зданием.",
          at: "2026-09-02T09:22:00.000Z",
          authorName: "Мила",
        },
      ],
    },
    {
      key: "беремен-капельниц",
      title: "можно ли капельницу при беременности",
      count: 3,
      lastAt: "2026-08-28T11:40:00.000Z",
      reasons: ["MEDICAL_QUESTION"],
      medical: true,
      questions: [
        { id: "q3", text: "можно ли капельницу при беременности", at: "2026-08-28T11:40:00.000Z" },
      ],
      answers: [
        {
          text: "Вам с вашим сроком лучше не надо, приходите после родов.",
          at: "2026-08-28T12:10:00.000Z",
          authorName: "Гаджи Абдурахманович Алунукачев",
        },
      ],
    },
    {
      key: "оплат-рассроч",
      title: "можно ли оплатить курс частями",
      count: 2,
      lastAt: "2026-08-20T08:05:00.000Z",
      reasons: ["MISUNDERSTOOD"],
      medical: false,
      questions: [
        { id: "q4", text: "можно ли оплатить курс частями", at: "2026-08-20T08:05:00.000Z" },
      ],
      answers: [],
    },
  ],
};

/** Звонить некому: у всех есть будущая запись. Это результат, а не пустота. */
const QUEUE_EMPTY: QueueData = {
  rows: [],
  withoutThreshold: 0,
  outcome: { outreaches: 0, booked: 0, arrived: 0, revenue: 0, days: 30 },
  slots: [
    { date: "2026-09-04", label: "чт, 4 сент.", windows: [], closedLabel: null },
    { date: "2026-09-05", label: "пт, 5 сент.", windows: null, closedLabel: "Санитарный день" },
    { date: "2026-09-06", label: "сб, 6 сент.", windows: [], closedLabel: null },
  ],
  attributionDays: 7,
};

/**
 * Боевая картина: закрытое окно, отсутствие переписки, неизвестная сумма,
 * четырёхзначные деньги и фамилия, которая обязана не ломать строку.
 */
const QUEUE_FULL: QueueData = {
  withoutThreshold: 42,
  outcome: { outreaches: 18, booked: 7, arrived: 5, revenue: 41200, days: 30 },
  attributionDays: 7,
  rows: [
    {
      patientId: "p1",
      patientName: "Абдурахманова-Гаджиева Патимат Магомедовна",
      kind: "COURSE_STALLED",
      basis: "БОС-терапия, сеанс · сеанс 4 из 10 · последний сеанс 24 дн. назад · порог услуги 14 дн. · будущих записей нет",
      money: 16800,
      moneyKind: "PREPAID",
      days: 24,
      courseId: "c1",
      contact: { channel: "whatsapp", windowOpen: false, windowHoursLeft: null, lastInboundDays: 12, hasDialog: true, phone: null },
    },
    {
      patientId: "p2",
      patientName: "Устинова Я. Б.",
      kind: "COURSE_FINISHING",
      basis: "Нейромедитация · сеанс 8 из 10 · дозаписать осталось 2 · последний сеанс вчера",
      money: 12000,
      moneyKind: "PREPAID",
      days: 1,
      courseId: "c2",
      contact: { channel: "instagram", windowOpen: true, windowHoursLeft: 19, lastInboundDays: 0, hasDialog: true, phone: null },
    },
    {
      patientId: "p3",
      patientName: "Фадеев Б. Г.",
      kind: "NO_SHOW",
      basis: "не пришёл 3 дн. назад · Остеопатия, приём · не перезаписан",
      money: 8000,
      moneyKind: "POTENTIAL",
      days: 3,
      contact: { channel: "telegram", windowOpen: true, windowHoursLeft: 4, lastInboundDays: 0, hasDialog: true, phone: null },
      courseId: null,
    },
    {
      patientId: "p4",
      patientName: "Цветков Д. Ж.",
      kind: "SLEEPING",
      basis: "последний визит 96 дн. назад · Забор анализов · запасной порог клиники 14 дн.",
      money: null,
      moneyKind: "POTENTIAL",
      days: 96,
      courseId: null,
      contact: { channel: null, windowOpen: false, windowHoursLeft: null, lastInboundDays: null, hasDialog: false, phone: "+7 928 000-00-00" },
    },
  ],
  slots: [
    {
      date: "2026-09-04",
      label: "чт, 4 сент.",
      windows: [
        { roomName: "Кабинет 2 — БОС-терапии", from: "14:30", to: "16:00", durationMin: 90 },
        { roomName: "Кабинет 3 — остеопата", from: "17:00", to: "21:00", durationMin: 240 },
      ],
      closedLabel: null,
    },
    { date: "2026-09-05", label: "пт, 5 сент.", windows: null, closedLabel: "Санитарный день" },
    {
      date: "2026-09-06",
      label: "сб, 6 сент.",
      windows: [{ roomName: "Кабинет 1 — процедурный", from: "09:00", to: "12:00", durationMin: 180 }],
      closedLabel: null,
    },
  ],
};

/**
 * Свежий месяц: курсы купили, но ни один ещё не решился. Доля неизвестна —
 * ноль означал бы «никто не дошёл», а это другое утверждение.
 */
const COURSES_EARLY: CourseEconomics = {
  hasCourses: true,
  // За период судить рано, но за всю историю ответ есть — его и показываем.
  repurchaseAllTime: {
    cohort: 21,
    repurchased: 6,
    rate: 6 / 21,
    tooEarly: 3,
    medianDaysToRepurchase: 41,
    windowDays: 90,
  },
  periodLabel: "сентябрь",
  completion: {
    completed: 0,
    abandoned: 0,
    inProgress: 4,
    rate: null,
    sessionsUsed: 3,
    sessionsPaid: 40,
    undecidable: 2,
  },
  outstanding: {
    obligation: 103600,
    sessions: 37,
    courses: 4,
    atRisk: 0,
    atRiskCourses: 0,
    scheduledSessions: 6,
  },
  repurchase: {
    cohort: 0,
    repurchased: 0,
    rate: null,
    tooEarly: 3,
    medianDaysToRepurchase: null,
    windowDays: 90,
  },
  rhythm: [],
};

/** Боевая картина квартала: четырёхзначные суммы и длинные названия услуг. */
const COURSES_FULL: CourseEconomics = {
  hasCourses: true,
  repurchaseAllTime: {
    cohort: 64,
    repurchased: 27,
    rate: 27 / 64,
    tooEarly: 4,
    medianDaysToRepurchase: 38,
    windowDays: 90,
  },
  periodLabel: "квартал",
  completion: {
    completed: 14,
    abandoned: 9,
    inProgress: 11,
    rate: 14 / 23,
    sessionsUsed: 218,
    sessionsPaid: 340,
    undecidable: 0,
  },
  outstanding: {
    obligation: 1284000,
    sessions: 122,
    courses: 31,
    atRisk: 344400,
    atRiskCourses: 9,
    scheduledSessions: 28,
  },
  repurchase: {
    cohort: 12,
    repurchased: 5,
    rate: 5 / 12,
    tooEarly: 4,
    medianDaysToRepurchase: 34,
    windowDays: 90,
  },
  rhythm: [
    { serviceTitle: "БОС-терапия, сеанс", medianDays: 7, meanDays: 9.4, gaps: 186, courses: 24 },
    {
      serviceTitle: "IV-терапия, капельница (расширенный протокол)",
      medianDays: 3,
      meanDays: 4.2,
      gaps: 64,
      courses: 9,
    },
    { serviceTitle: "Нейромедитация", medianDays: 14, meanDays: 15.5, gaps: 12, courses: 3 },
  ],
};

/** Ни визитов, ни переписки: дело не пустое — его пока нет. */
const DOSSIER_EMPTY: DossierView = {
  visits: { total: 0, arrived: 0, noShow: 0, cancelled: 0, unmarked: 0, firstAt: null, lastAt: null },
  services: [],
  staff: [],
  rhythm: { medianDays: null, meanDays: null, gaps: 0 },
  money: { total: 0, paidVisits: 0, avgCheck: null },
  style: {
    messages: 0,
    enough: false,
    medianLength: null,
    medianReplyMinutes: null,
    typicalHour: null,
    greetsShare: null,
    address: null,
    voiceOrPhotos: 0,
    askedForHuman: 0,
  },
  advice: [],
  courses: [],
  contact: { channel: null, lastInboundAt: null, dialogs: 0 },
  source: null,
};

/** Один визит и два сообщения: ритма нет, манеры нет — и это сказано словами. */
const DOSSIER_THIN: DossierView = {
  ...DOSSIER_EMPTY,
  visits: {
    total: 1,
    arrived: 1,
    noShow: 0,
    cancelled: 0,
    unmarked: 0,
    firstAt: "2026-08-20T09:00:00.000Z",
    lastAt: "2026-08-20T09:00:00.000Z",
  },
  services: [{ title: "Консультация", count: 1, revenue: 3000 }],
  staff: [{ name: "Омарова И.", count: 1 }],
  money: { total: 3000, paidVisits: 1, avgCheck: 3000 },
  style: { ...DOSSIER_EMPTY.style, messages: 2 },
  contact: { channel: "WHATSAPP", lastInboundAt: "2026-08-19T18:20:00.000Z", dialogs: 1 },
  source: { title: "WhatsApp", confidence: "DERIVED" },
};

/** Постоянная пациентка: курс, неявки, вечерняя переписка, длинные названия. */
const DOSSIER_FULL: DossierView = {
  visits: {
    total: 34,
    arrived: 29,
    noShow: 2,
    cancelled: 1,
    unmarked: 2,
    firstAt: "2024-11-12T09:00:00.000Z",
    lastAt: "2026-09-01T15:30:00.000Z",
  },
  services: [
    { title: "БОС-терапия, сеанс", count: 18, revenue: 50400 },
    { title: 'Инфузия "Амино-Архитектура" (Белковое восстановление)', count: 7, revenue: 63000 },
    { title: "Остеопатия, приём Ирины", count: 4, revenue: 32000 },
  ],
  staff: [
    { name: "Абдурахманова-Гаджиева П. М.", count: 21 },
    { name: "Омарова И.", count: 8 },
  ],
  rhythm: { medianDays: 9, meanDays: 12.4, gaps: 28 },
  money: { total: 145400, paidVisits: 13, avgCheck: 11184 },
  style: {
    messages: 62,
    enough: true,
    medianLength: 28,
    medianReplyMinutes: 214,
    typicalHour: 21,
    greetsShare: 0.82,
    address: "formal",
    voiceOrPhotos: 5,
    askedForHuman: 2,
  },
  advice: [
    { text: "Здоровается — поздоровайтесь в ответ.", basis: "приветствие в 82% сообщений" },
    { text: "Обращается на «вы».", basis: "по словам в переписке" },
    {
      text: "Пишет коротко — длинный список услуг не прочитает.",
      basis: "обычная длина сообщения 28 знаков",
    },
    {
      text: "Пишет вечером — ответ раньше 21:00 ждать не стоит.",
      basis: "обычное время сообщений — около 21:00",
    },
    { text: "Отвечает не сразу — молчание не значит отказ.", basis: "обычно отвечает через 3,6 ч" },
    {
      text: "Просил живого человека — не отдавайте разговор ассистенту.",
      basis: "просил 2 раза",
    },
    {
      text: "Не доходил дважды и больше — подтвердите запись накануне.",
      basis: "неявок: 2",
    },
    {
      text: "Ходит примерно раз в 9 дн. — от этого и предлагайте дату.",
      basis: "по 28 промежуткам между визитами",
    },
  ],
  courses: [
    { title: "БОС-терапия, сеанс", used: 8, total: 10, booked: 2, status: "ACTIVE" },
    { title: 'Инфузия "Амино-Архитектура" (Белковое восстановление)', used: 10, total: 10, booked: 0, status: "COMPLETED" },
  ],
  contact: { channel: "WHATSAPP", lastInboundAt: "2026-09-02T20:14:00.000Z", dialogs: 2 },
  source: { title: "Instagram", confidence: "MANUAL" },
};

function Case({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-border border-t pt-6 pb-10">
      <div className="mb-5 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-md font-medium">{title}</h2>
        <p className="text-text-subtle text-xs">{note}</p>
      </div>
      {children}
    </section>
  );
}

export default function StatesPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <div className="flex-1 overflow-auto px-7 py-8 max-md:px-5">
      <header className="mb-9">
        <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">Состояния</h1>
        <p className="text-text-muted mt-2 max-w-[70ch] text-sm leading-relaxed">
          Служебный экран: граничные случаи проверяются здесь, а не на живых
          данных.
        </p>
      </header>

      <Case title="Пустой день" note="кабинеты свободны с открытия">
        <div className="grid grid-cols-3 gap-4 max-lg:grid-cols-1">
          {EMPTY_CABINETS.map((c) => (
            <CabinetCard key={c.id} cabinet={c} />
          ))}
        </div>
      </Case>

      <Case title="Пустые очереди" note="ни эскалаций, ни новых обращений">
        <div className="grid grid-cols-2 gap-x-8 gap-y-6 max-lg:grid-cols-1">
          <AttentionList items={[]} />
          <InquiryList items={[]} />
        </div>
      </Case>

      <Case title="Все кабинеты заняты" note="свободных окон нет — это тоже ответ">
        <FreeWindows windows={[]} />
      </Case>

      <Case title="Четырёхзначные числа" note="квартальные значения в дневной шапке">
        <div className="text-text-muted flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
          <span>
            Выручка{" "}
            <b className="num text-text font-medium">
              {BIG_SUMMARY.revenue.toLocaleString("ru-RU")} ₽
            </b>
          </span>
          <span aria-hidden className="sep-dot" />
          <span>
            <b className="num text-text font-medium">{BIG_SUMMARY.scheduled.toLocaleString("ru-RU")}</b>{" "}
            записей
          </span>
          <span aria-hidden className="sep-dot" />
          <span>
            <b className="num text-text font-medium">{BIG_SUMMARY.firstVisits}</b> первичных
          </span>
        </div>
      </Case>

      <Case title="Длинные фамилии" note="двойная с отчеством в карточке и окнах">
        <div className="grid grid-cols-3 gap-4 max-lg:grid-cols-1">
          <CabinetCard cabinet={LONG_CABINET} />
          <div className="col-span-2 max-lg:col-span-1">
            <FreeWindows windows={LONG_WINDOWS} />
          </div>
        </div>
      </Case>

      <Case title="Загрузка" note="каркас на месте, дышит серым">
        <div className="grid grid-cols-3 gap-4 max-lg:grid-cols-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className="border-border bg-surface rounded-xl border p-[18px]">
              <div className="skeleton h-4 w-28 rounded-sm" />
              <div className="skeleton mt-2 h-3 w-24 rounded-sm" />
              <div className="border-border-soft my-[15px] border-t" />
              <div className="skeleton h-4 w-40 rounded-sm" />
              <div className="skeleton mt-4 h-[70px] w-full rounded-lg" />
            </div>
          ))}
        </div>
      </Case>

      {/*
        «Работа ассистента» — три состояния, из-за которых раздел легко читать
        неверно: пустой период, нехватка базы для сравнения и крупные числа.
        Данные ниже выдуманы намеренно, как и всё на этом экране.
      */}
      <Case title="Ассистент: за период данных нет" note="пусто показываем словами, а не нулями">
        <AgentSection stats={AGENT_EMPTY} periodLabel="за 30 дней · 04.08 — 03.09" />
      </Case>

      <Case
        title="Ассистент: базы для сравнения не хватило"
        note="экономию не считаем и говорим почему"
      >
        <AgentSection stats={AGENT_NO_BASE} periodLabel="за 30 дней · 04.08 — 03.09" />
      </Case>

      <Case title="Ассистент: крупные числа" note="четырёхзначные значения и длинные темы">
        <AgentSection stats={AGENT_BIG} periodLabel="за 90 дней · 05.06 — 03.09" />
      </Case>

      {/*
        Источник визита в трёх состояниях. Они выглядят по-разному не для
        красоты: «Instagram» и «Instagram · из переписки» — разные утверждения,
        и администратор должен видеть, правит он догадку системы или чужой
        ответ. Справочник на этом экране не грузится — нажатие покажет строку
        загрузки, и это тоже состояние.
      */}
      <Case title="Источник визита" note="проставлен человеком, выведен из переписки, неизвестен">
        <div className="border-border bg-surface flex max-w-[560px] flex-col gap-3 rounded-xl border p-5">
          <SourcePicker
            state={{ code: "instagram", title: "Instagram", confidence: "MANUAL" }}
            onPick={() => {}}
          />
          <SourcePicker
            state={{ code: "whatsapp", title: "WhatsApp", confidence: "DERIVED" }}
            onPick={() => {}}
          />
          <SourcePicker state={{ code: null, title: null, confidence: "UNKNOWN" }} onPick={() => {}} />
          {/* Длинное название источника не должно ломать строку визита. */}
          <SourcePicker
            state={{
              code: "referral",
              title: "Рекомендация коллеги из соседней клиники",
              confidence: "MANUAL",
            }}
            onPick={() => {}}
          />
          {/* Только чтение: чужой день, отметки там не ставят. */}
          <SourcePicker
            state={{ code: "phone", title: "Звонок", confidence: "MANUAL" }}
            readOnly
            onPick={() => {}}
          />
        </div>
      </Case>

      {/*
        Разрез по источникам, когда источник неизвестен почти везде. Это
        боевое состояние на день внедрения: 741 визит из 741 без источника.
        Строка «неизвестен» стоит наравне с остальными и со своим числом —
        иначе доли считаются от одних опознанных записей и «WhatsApp — 100%»
        означает одну запись из семисот сорока одной.
      */}
      <Case title="Источники: почти всё неизвестно" note="строка «неизвестен» не прячется">
        <div className="border-border bg-surface max-w-[560px] rounded-xl border p-5">
          <ul className="flex flex-col gap-3">
            {SOURCES_MOSTLY_UNKNOWN.map((s) => (
              <li key={s.code} className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-3">
                <span className={`truncate text-sm ${s.unknown ? "text-text-muted" : ""}`}>
                  {s.title}
                </span>
                <div className="flex items-center gap-3">
                  <div className="bg-list-gap rounded-pill h-2 flex-1 overflow-hidden">
                    <div className="bg-accent rounded-pill h-full" style={{ width: `${s.share * 100}%` }} />
                  </div>
                  <span className="num text-text-subtle w-32 flex-none text-right text-2xs">
                    {s.unknown ? `${s.booked} записей · 97%` : `${s.inquiries} → ${s.booked}`}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-text-subtle mt-4 text-2xs">
            Источник у 18 из 741 записей выведен из переписки, у 3 проставлен вручную, 720 остались
            неизвестными. Неизвестный источник — это звонок или приход без переписки; догадкой он не
            заполняется.
          </p>
        </div>
      </Case>

      {/*
        Пробелы в справочнике. Пустое состояние — не «0 групп», а фраза: за
        срок ассистент ни разу не остался без ответа. Это разные утверждения.
      */}
      <Case title="Пробелы: за срок ни одного" note="пусто показываем словами">
        <div className="max-w-[820px]">
          <GapsBlock data={GAPS_EMPTY} onDraft={() => {}} />
        </div>
      </Case>

      <Case
        title="Пробелы: медицинская тема и длинные вопросы"
        note="кнопка создаёт черновик, а не запись"
      >
        <div className="max-w-[820px]">
          <GapsBlock data={GAPS_FULL} onDraft={() => {}} />
        </div>
      </Case>

      {/*
        Очередь «Кому позвонить». Пустая — это не сбой: у всех, кто мог бы
        попасть в список, есть будущая запись. Так и написано словами.
      */}
      <Case title="Кому позвонить: звонить некому" note="пусто — это результат, а не поломка">
        <div className="border-border rounded-xl border">
          <QueueClient data={QUEUE_EMPTY} />
        </div>
      </Case>

      <Case
        title="Кому позвонить: закрытое окно, неизвестная сумма, длинные фамилии"
        note="состояние окна видно до попытки написать"
      >
        <div className="border-border rounded-xl border">
          <QueueClient data={QUEUE_FULL} />
        </div>
      </Case>

      {/*
        Экономика курсов в свежем месяце: решившихся курсов ещё нет, судить
        рано. Прочерк и слова, а не «0%»: ноль означал бы «никто не дошёл».
      */}
      <Case title="Курсы: судить рано" note="прочерк вместо нуля — это разные утверждения">
        <div className="border-border bg-surface max-w-[820px] rounded-xl border p-5">
          <CourseEconomicsBlock data={COURSES_EARLY} />
        </div>
      </Case>

      <Case title="Курсы: обязательства и возвраты" note="крупные суммы и подпись «это не выручка»">
        <div className="border-border bg-surface max-w-[820px] rounded-xl border p-5">
          <CourseEconomicsBlock data={COURSES_FULL} />
        </div>
      </Case>

      {/*
        Личное дело. Два состояния, которые важнее полного: пустое (нечего
        рассказывать — так и написано) и «мало наблюдений» — когда визиты есть,
        а о манере общения судить не по чему. Совет, построенный на двух
        сообщениях, администратор понесёт в разговор с живым человеком.
      */}
      <Case title="Личное дело: рассказывать нечего" note="ни визитов, ни переписки">
        <div className="border-border bg-surface max-w-[560px] rounded-xl border p-5">
          <DossierBody data={DOSSIER_EMPTY} />
        </div>
      </Case>

      <Case
        title="Личное дело: наблюдений мало"
        note="визиты есть, о манере судить не по чему"
      >
        <div className="border-border bg-surface max-w-[560px] rounded-xl border p-5">
          <DossierBody data={DOSSIER_THIN} />
        </div>
      </Case>

      <Case title="Личное дело: полное" note="длинные названия услуг и четырёхзначные суммы">
        <div className="border-border bg-surface max-w-[560px] rounded-xl border p-5">
          <DossierBody data={DOSSIER_FULL} />
        </div>
      </Case>

      <Case title="Ошибка" note="что не прочиталось и что делать">
        <div className="border-border bg-surface max-w-[560px] rounded-xl border p-5">
          <p className="text-md font-medium">Данные смены не загрузились</p>
          <p className="text-text-muted mt-2 text-sm leading-relaxed">
            Экран читает локальную проекцию YCLIENTS. Записи и деньги в самом
            YCLIENTS не пострадали.
          </p>
          <button
            type="button"
            className="bg-accent text-accent-contrast hover:bg-accent-hover mt-5 rounded-md px-4 py-2 text-sm font-medium"
          >
            Загрузить снова
          </button>
        </div>
      </Case>
    </div>
  );
}
