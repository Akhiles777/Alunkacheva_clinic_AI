/**
 * Мок-стор настроек платформы (волна 2). Форма — под реальные модели волны 1
 * (Setting, ClinicSchedule, Room, Service, ServiceRoom, Source, RolePermission,
 * Credential, MessageTemplate, KnowledgeEntry, ConsentDocument).
 *
 * Это визуальный слой: правки держатся в памяти сессии, серверная запись
 * (Server Actions + шифрование Credential + проверка прав) подключается позже.
 * Секреты, тем не менее, реально шифруются через lib/crypto и наружу отдаются
 * только маской.
 */
import type { Permission, Role } from "@/lib/permissions";

// Реальное шифрование Credential (AES-256-GCM, lib/crypto) — серверное, на
// записи в БД (позже). В браузер node:crypto не тянем: здесь только маска.

export interface DaySchedule {
  weekday: number; // 1..7 (Пн..Вс)
  enabled: boolean;
  startMinute: number;
  endMinute: number;
}

export interface ScheduleException {
  id: string;
  date: string; // ISO date
  label: string;
  closed: boolean;
}

export interface ClinicSettings {
  name: string;
  timezone: string;
  dayBoundaryMinute: number; // граница отчётных суток
  schedule: DaySchedule[];
  exceptions: ScheduleException[];
}

export interface RoomSettings {
  id: string;
  name: string;
  direction: string;
  isActive: boolean;
  inheritsClinicSchedule: boolean;
  /** Источник кабинета для загрузки. */
  sourceMode: "resource" | "staff";
}

export interface ServiceSettings {
  id: string;
  title: string;
  direction: string;
  durationMin: number;
  price: number;
  isActive: boolean;
  isCourse: boolean;
  defaultSessions: number | null;
  stalledAfterDays: number | null;
  roomIds: string[];
}

export interface SourceSettings {
  id: string;
  code: string;
  title: string;
  isActive: boolean;
  sortOrder: number;
}

export interface StaffSettings {
  id: string;
  name: string;
  specialty: string;
  roomId: string | null; // закреплённый кабинет, null — принимает в разных
  isActive: boolean;
}

export interface StaffAccount {
  id: string;
  name: string;
  email: string;
  role: Role;
  isActive: boolean;
}


export interface KnowledgeItem {
  id: string;
  topic: string;
  question: string;
  answer: string;
  serviceId: string | null;
  isActive: boolean;
}

export interface TemplateItem {
  id: string;
  code: string;
  title: string;
  body: string;
  status: "draft" | "pending" | "approved" | "rejected";
}

export interface AuditRow {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
}

const ROOMS: RoomSettings[] = [
  { id: "room-1", name: "Кабинет 1 — процедурный", direction: "IV-терапия", isActive: true, inheritsClinicSchedule: true, sourceMode: "staff" },
  { id: "room-2", name: "Кабинет 2 — БОС-терапии", direction: "БОС-терапия", isActive: true, inheritsClinicSchedule: true, sourceMode: "staff" },
  { id: "room-3", name: "Кабинет 3 — остеопата", direction: "Остеопатия", isActive: true, inheritsClinicSchedule: true, sourceMode: "resource" },
];

const SERVICES: ServiceSettings[] = [
  { id: "s-osteo-1", title: "Остеопатия, приём", direction: "Остеопатия", durationMin: 60, price: 7000, isActive: true, isCourse: false, defaultSessions: null, stalledAfterDays: null, roomIds: ["room-3"] },
  { id: "s-iv-1", title: "IV-терапия, капельница", direction: "IV-терапия", durationMin: 90, price: 6500, isActive: true, isCourse: true, defaultSessions: 10, stalledAfterDays: 10, roomIds: ["room-1", "room-2"] },
  { id: "s-bos-1", title: "БОС-терапия, сеанс", direction: "БОС-терапия", durationMin: 40, price: 5000, isActive: true, isCourse: true, defaultSessions: 12, stalledAfterDays: 14, roomIds: ["room-2"] },
  { id: "s-neuro-1", title: "Нейромедитация", direction: "Нейромедитация", durationMin: 30, price: 6000, isActive: true, isCourse: false, defaultSessions: null, stalledAfterDays: null, roomIds: ["room-2"] },
  { id: "s-lab-1", title: "Забор анализов", direction: "Анализы", durationMin: 15, price: 1500, isActive: true, isCourse: false, defaultSessions: null, stalledAfterDays: null, roomIds: ["room-1"] },
];

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

function defaultSchedule(): DaySchedule[] {
  return WEEKDAYS.map((_, i) => ({
    weekday: i + 1,
    enabled: i < 6, // Пн–Сб рабочие, Вс выходной
    startMinute: 9 * 60,
    endMinute: 21 * 60,
  }));
}

const ROLE_MATRIX: Record<Role, Permission[]> = {
  OWNER: ["VIEW_OTHER_PATIENTS", "VIEW_REVENUE", "EDIT_SETTINGS", "MESSAGE_PATIENTS", "VIEW_AUDIT"],
  MANAGER: ["VIEW_OTHER_PATIENTS", "VIEW_REVENUE", "MESSAGE_PATIENTS", "VIEW_AUDIT"],
  ADMIN: ["VIEW_OTHER_PATIENTS", "MESSAGE_PATIENTS"],
  DOCTOR: [],
};

/** Единый мутируемый стор. Живёт в памяти клиента в рамках сессии. */
export const settingsStore = {
  clinic: {
    name: "Мера",
    timezone: "Europe/Moscow",
    dayBoundaryMinute: 0,
    schedule: defaultSchedule(),
    exceptions: [
      { id: "e1", date: "2026-01-01", label: "Новый год", closed: true },
      { id: "e2", date: "2026-06-14", label: "Санитарный день", closed: true },
    ],
  } as ClinicSettings,
  rooms: ROOMS,
  services: SERVICES,
  sources: [
    { id: "src-ig", code: "instagram", title: "Instagram", isActive: true, sortOrder: 10 },
    { id: "src-wa", code: "whatsapp", title: "WhatsApp", isActive: true, sortOrder: 20 },
    { id: "src-phone", code: "phone", title: "Звонок", isActive: true, sortOrder: 30 },
    { id: "src-site", code: "site", title: "Сайт", isActive: true, sortOrder: 40 },
    { id: "src-off", code: "offline", title: "Пришёл сам", isActive: true, sortOrder: 50 },
    { id: "src-ref", code: "referral", title: "Рекомендация", isActive: true, sortOrder: 60 },
  ] as SourceSettings[],
  staff: [
    { id: "st-1", name: "Левин А. И.", specialty: "Остеопат", roomId: "room-3", isActive: true },
    { id: "st-2", name: "Соколова Е. В.", specialty: "Остеопат", roomId: null, isActive: true },
    { id: "st-3", name: "Мороз Д. С.", specialty: "Специалист по Лотосу", roomId: null, isActive: true },
    { id: "st-4", name: "Ефимова Н. П.", specialty: "БОС-терапевт", roomId: "room-2", isActive: true },
    { id: "st-5", name: "Литвинова О. А.", specialty: "Медсестра · Лотос", roomId: null, isActive: true },
    { id: "st-6", name: "Гущина Р. К.", specialty: "Медсестра", roomId: null, isActive: true },
  ] as StaffSettings[],
  accounts: [
    { id: "acc-1", name: "Ирина Долева", email: "irina@mera.clinic", role: "ADMIN", isActive: true },
    { id: "acc-2", name: "Пётр Веденин", email: "petr@mera.clinic", role: "ADMIN", isActive: true },
    { id: "acc-3", name: "Ольга Мерова", email: "owner@mera.clinic", role: "OWNER", isActive: true },
  ] as StaffAccount[],
  roleMatrix: ROLE_MATRIX,
  assistant: {
    mode: "drafts" as "on" | "off" | "drafts",
    greeting: "Здравствуйте! Это клиника «Мера». Чем помочь?",
    signature: "— команда «Мера»",
    stopWords: ["жалоба", "боль", "вернуть деньги", "юрист", "врач ошибся"],
  },
  knowledge: [
    { id: "k1", topic: "Адрес", question: "Где вы находитесь?", answer: "Москва, ул. Примерная, 1.", serviceId: null, isActive: true },
    { id: "k2", topic: "Часы работы", question: "Когда вы работаете?", answer: "Пн–Сб, 09:00–21:00.", serviceId: null, isActive: true },
    { id: "k3", topic: "Подготовка к IV", question: "Как готовиться к капельнице?", answer: "Лёгкий приём пищи за 1–2 часа, питьевой режим.", serviceId: "s-iv-1", isActive: true },
  ] as KnowledgeItem[],
  templates: [
    { id: "t1", code: "reminder_visit", title: "Напоминание о визите", body: "Здравствуйте, {{name}}! Напоминаем о визите {{date}} в {{time}}.", status: "approved" },
    { id: "t2", code: "course_stalled", title: "Возврат к курсу", body: "Здравствуйте, {{name}}! У вас остались сеансы курса. Записать вас?", status: "pending" },
  ] as TemplateItem[],
  notifications: {
    batchWeekdays: [7], // Вс копим до Пн
    quietFrom: 22 * 60,
    quietTo: 8 * 60,
    escalation: true,
    newInquiry: true,
    cancel: true,
  },
  consent: {
    version: "1.0",
    text: "Согласие на обработку персональных данных. Текст заполняется клиникой.",
    policyUrl: "",
  },
  audit: [
    { id: "au1", at: "23 июля, 10:41", actor: "Ирина Долева", action: "Просмотр карточки", target: "Гринберг И. Л." },
    { id: "au2", at: "23 июля, 10:05", actor: "Пётр Веденин", action: "Изменение настроек", target: "Услуги" },
    { id: "au3", at: "23 июля, 09:58", actor: "Ирина Долева", action: "Отправка сообщения", target: "Чернышёва Ж. З." },
  ] as AuditRow[],
};

// Интеграции переехали на сервер: данные читаются из таблицы Credential
// через server actions (settings/integrations/actions.ts), а не из мока.

export { WEEKDAYS };
