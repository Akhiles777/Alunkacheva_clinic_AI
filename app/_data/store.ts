/**
 * Общий изменяемый стор визуального слоя (сессия в памяти браузера).
 *
 * Раньше экраны читали разрозненные статичные массивы, поэтому «добавить /
 * удалить» было негде отразить. Теперь одно состояние, подписка через
 * useSyncExternalStore — добавление пациента, номера, пометки или звонка сразу
 * видно везде: в списке, в карточке, в поиске.
 *
 * Форма — под модели волны 1 (PatientPhone, PatientNote, PatientRelation,
 * CallLog, Course). Серверная запись подключится позже; здесь — рабочая
 * логика и связки.
 */
import { useSyncExternalStore } from "react";
import { normalizePhone, formatPhone } from "@/lib/phone";

export type Channel = "instagram" | "whatsapp" | "phone" | "offline";
export type NoteKind = "NO_CONSENT" | "INCOMPLETE_PASSPORT" | "ATTENTION" | "CUSTOM";
export type RelationKind = "PARENT" | "GUARDIAN" | "SPOUSE" | "OTHER";

export interface Phone {
  id: string;
  e164: string;
  pretty: string;
  label: string | null;
  isPrimary: boolean;
  whatsapp: boolean;
}
export interface Note {
  id: string;
  kind: NoteKind;
  text: string;
  createdAt: string;
  resolved: boolean;
}
export interface Relation {
  id: string;
  relatedPatientId: string;
  kind: RelationKind;
}
export interface Course {
  id: string;
  title: string;
  used: number;
  total: number;
  status: "active" | "stalled" | "done";
  lastVisit: string;
  /** Появилась будущая запись — курс уходит из «выпавших». Задаётся при записи. */
  hasFuture?: boolean;
}

export interface Appt {
  id: string;
  roomId: string;
  roomName: string;
  doctor: string;
  service: string;
  patientId: string | null;
  patientName: string;
  startMinute: number;
  durationMin: number;
  status: "planned" | "confirmed" | "arrived" | "no_show";
  isFirstVisit: boolean;
}
export interface Visit {
  id: string;
  date: string;
  service: string;
  doctor: string;
  status: "arrived" | "no_show" | "cancelled" | "planned";
  amount: number;
}
export interface Message {
  id: string;
  from: "patient" | "staff" | "bot";
  text: string;
  at: string;
}
export interface CallRecord {
  id: string;
  at: string;
  patientId: string | null;
  phone: string;
  direction: "in" | "out";
  serviceInterest: string | null;
  source: string | null;
  note: string;
}
export interface Patient {
  id: string;
  name: string;
  bornYear: number | null;
  firstSeen: string;
  source: string;
  channel: Channel;
  phones: Phone[];
  notes: Note[];
  relations: Relation[];
  courses: Course[];
  visits: Visit[];
  messages: Message[];
}

export type DialogChannel = "instagram" | "whatsapp";
export type DialogStatus = "bot" | "escalated" | "human" | "closed";

export interface Dialog {
  id: string;
  name: string;
  channel: DialogChannel;
  patientId: string | null;
  status: DialogStatus;
  preview: string;
  at: string;
  unread: boolean;
  escalationReason?: string;
  agentDraft?: string;
  messages: Message[];
  /** Окно ответа: открыто — можно свободным текстом; закрыто — только шаблон. */
  windowOpen: boolean;
  /** Сколько минут до закрытия окна, если открыто. null — окно без таймера. */
  windowMinutesLeft: number | null;
}

export interface DB {
  patients: Patient[];
  calls: CallRecord[];
  dialogs: Dialog[];
}

// ─────────────────────────────────────────────── seed

let seq = 1000;
function uid(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}
function phone(e164: string, opts: Partial<Phone> = {}): Phone {
  return {
    id: uid("ph"),
    e164,
    pretty: formatPhone(e164),
    label: null,
    isPrimary: false,
    whatsapp: false,
    ...opts,
  };
}

const INITIAL: DB = {
  patients: [
    {
      id: "p-grinberg",
      name: "Гринберг Ирина Львовна",
      bornYear: 1984,
      firstSeen: "12 марта 2026",
      source: "Instagram",
      channel: "instagram",
      phones: [
        phone("+79161234567", { isPrimary: true, whatsapp: true, label: "личный" }),
        phone("+79031112233", { label: "муж" }),
      ],
      notes: [{ id: uid("n"), kind: "ATTENTION", text: "Просила звонить после 18:00", createdAt: "10 июля", resolved: false }],
      relations: [{ id: uid("r"), relatedPatientId: "p-belov", kind: "SPOUSE" }],
      courses: [{ id: "c1", title: "IV-терапия, капельница", used: 6, total: 10, status: "active", lastVisit: "сегодня" }],
      visits: [
        { id: "v1", date: "23 июля", service: "IV-терапия, капельница", doctor: "Соколова Е.", status: "arrived", amount: 6500 },
        { id: "v2", date: "16 июля", service: "IV-терапия, капельница", doctor: "Соколова Е.", status: "arrived", amount: 6500 },
        { id: "v3", date: "9 июля", service: "IV-терапия, капельница", doctor: "Соколова Е.", status: "arrived", amount: 6500 },
        { id: "v4", date: "2 июля", service: "Первичный приём", doctor: "Соколова Е.", status: "arrived", amount: 3500 },
      ],
      messages: [
        { id: "m1", from: "patient", text: "Здравствуйте, а капельница сегодня во сколько?", at: "10:30" },
        { id: "m2", from: "bot", text: "Здравствуйте! Вы записаны на 11:00 в кабинет 2.", at: "10:31" },
        { id: "m3", from: "patient", text: "А есть побочные эффекты от этого состава?", at: "10:38" },
      ],
    },
    {
      id: "p-belov",
      name: "Белов Лев Кириллович",
      bornYear: 1991,
      firstSeen: "сегодня",
      source: "WhatsApp",
      channel: "whatsapp",
      phones: [phone("+79031112233", { isPrimary: true, whatsapp: true })],
      notes: [{ id: uid("n"), kind: "INCOMPLETE_PASSPORT", text: "Нет паспортных данных", createdAt: "сегодня", resolved: false }],
      relations: [{ id: uid("r"), relatedPatientId: "p-grinberg", kind: "SPOUSE" }],
      courses: [],
      visits: [{ id: "v1", date: "23 июля", service: "Остеопатия, приём", doctor: "Левин А.", status: "arrived", amount: 4200 }],
      messages: [{ id: "m1", from: "patient", text: "Спасибо, всё подошло. Можно записаться ещё раз?", at: "10:18" }],
    },
    {
      id: "p-sedyh",
      name: "Седых Дмитрий Петрович",
      bornYear: 1978,
      firstSeen: "4 апреля 2026",
      source: "Рекомендация",
      channel: "phone",
      phones: [phone("+79267778899", { isPrimary: true })],
      notes: [],
      relations: [],
      courses: [{ id: "c1", title: "Остеопатия, курс", used: 4, total: 10, status: "stalled", lastVisit: "18 дней назад" }],
      visits: [
        { id: "v1", date: "5 июля", service: "Остеопатия, коррекция", doctor: "Левин А.", status: "arrived", amount: 4200 },
        { id: "v2", date: "28 июня", service: "Остеопатия, коррекция", doctor: "Левин А.", status: "arrived", amount: 4200 },
      ],
      messages: [],
    },
    {
      id: "p-konst",
      name: "Константинопольская-Ржевская Аполлинария Владиславовна",
      bornYear: 1965,
      firstSeen: "сегодня",
      source: "Сайт",
      channel: "instagram",
      phones: [phone("+79995554433", { isPrimary: true })],
      notes: [{ id: uid("n"), kind: "NO_CONSENT", text: "Не подписано согласие на обработку ПДн", createdAt: "сегодня", resolved: false }],
      relations: [],
      courses: [],
      visits: [{ id: "v1", date: "23 июля", service: "Остеопатия, приём", doctor: "Левин А.", status: "planned", amount: 0 }],
      messages: [],
    },
    {
      id: "p-chern",
      name: "Чернышёва Жанна Захаровна",
      bornYear: 1996,
      firstSeen: "20 июня 2026",
      source: "Instagram",
      channel: "whatsapp",
      phones: [phone("+79104443322", { isPrimary: true, whatsapp: true })],
      notes: [],
      relations: [],
      courses: [{ id: "c1", title: "БОС-терапия, курс", used: 1, total: 8, status: "active", lastVisit: "3 дня назад" }],
      visits: [{ id: "v1", date: "20 июля", service: "БОС-терапия, сеанс", doctor: "Мороз Д.", status: "arrived", amount: 5000 }],
      messages: [{ id: "m1", from: "patient", text: "Можно перенести завтрашний сеанс на вечер?", at: "10:40" }],
    },
  ],
  calls: [],
  dialogs: [
    {
      id: "d-grinberg",
      name: "Гринберг Ирина Львовна",
      channel: "instagram",
      patientId: "p-grinberg",
      status: "escalated",
      preview: "А есть побочные эффекты от этого состава?",
      at: "10:38",
      unread: true,
      escalationReason: "медицинский вопрос",
      windowOpen: true,
      windowMinutesLeft: 322,
      messages: [
        { id: "m1", from: "patient", text: "Здравствуйте, а капельница сегодня во сколько?", at: "10:30" },
        { id: "m2", from: "bot", text: "Здравствуйте! Вы записаны на 11:00 в кабинет 2.", at: "10:31" },
        { id: "m3", from: "patient", text: "А есть побочные эффекты от этого состава?", at: "10:38" },
      ],
    },
    {
      id: "d-chern",
      name: "Чернышёва Жанна Захаровна",
      channel: "whatsapp",
      patientId: "p-chern",
      status: "human",
      preview: "Можно перенести завтрашний сеанс на вечер?",
      at: "10:40",
      unread: true,
      agentDraft:
        "Здравствуйте! Да, на завтра есть свободное окно в 18:30 в кабинете 3. Перенести ваш сеанс на это время?",
      windowOpen: true,
      windowMinutesLeft: 40,
      messages: [{ id: "m1", from: "patient", text: "Можно перенести завтрашний сеанс на вечер?", at: "10:40" }],
    },
    {
      id: "d-newiv",
      name: "Новый номер +7 916 320-14-08",
      channel: "instagram",
      patientId: null,
      status: "bot",
      preview: "Здравствуйте! Сколько стоит курс капельниц?",
      at: "10:42",
      unread: true,
      windowOpen: true,
      windowMinutesLeft: 18,
      messages: [
        { id: "m1", from: "patient", text: "Здравствуйте! Сколько стоит курс капельниц?", at: "10:42" },
        { id: "m2", from: "bot", text: "Курс IV-терапии из 10 капельниц — 65 000 ₽. Рассказать или записать на первую?", at: "10:42" },
      ],
    },
    {
      id: "d-belov",
      name: "Белов Лев Кириллович",
      channel: "whatsapp",
      patientId: "p-belov",
      status: "bot",
      preview: "Спасибо, всё подошло. Можно записаться ещё раз?",
      at: "10:18",
      unread: false,
      windowOpen: true,
      windowMinutesLeft: null,
      messages: [
        { id: "m1", from: "patient", text: "Спасибо, всё подошло. Можно записаться ещё раз?", at: "10:18" },
        { id: "m2", from: "bot", text: "Рады помочь! На какое направление вас записать?", at: "10:18" },
      ],
    },
    {
      id: "d-newost",
      name: "Новый номер +7 903 771-52-30",
      channel: "whatsapp",
      patientId: null,
      status: "closed",
      preview: "А остеопат принимает детей?",
      at: "вчера",
      unread: false,
      // Окно закрыто — писать первым можно только утверждённым шаблоном.
      windowOpen: false,
      windowMinutesLeft: null,
      messages: [
        { id: "m1", from: "patient", text: "А остеопат принимает детей?", at: "вчера" },
        { id: "m2", from: "bot", text: "Да, принимает с 6 лет. Записать на консультацию?", at: "вчера" },
        { id: "m3", from: "patient", text: "Спасибо, я подумаю", at: "вчера" },
      ],
    },
  ],
};

// ─────────────────────────────────────────────── реактивность

let db: DB = INITIAL;
const listeners = new Set<() => void>();

function commit(next: DB) {
  db = next;
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
function getSnapshot(): DB {
  return db;
}

/** Реактивное чтение стора в клиентских компонентах. */
export function useDb(): DB {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Разовое чтение без подписки. */
export function getDb(): DB {
  return db;
}

// ─────────────────────────────────────────────── производные

export function primaryPhone(p: Patient): Phone | null {
  return p.phones.find((ph) => ph.isPrimary) ?? p.phones[0] ?? null;
}

export function patientTags(p: Patient): string[] {
  const tags: string[] = [];
  if (p.firstSeen === "сегодня") tags.push("первичный");
  if (p.courses.some((c) => c.status === "active")) tags.push("на курсе");
  if (p.courses.some((c) => c.status === "stalled")) tags.push("выпал из курса");
  if (p.notes.some((n) => n.kind === "NO_CONSENT" && !n.resolved)) tags.push("без согласия");
  return tags;
}

export function activeNotes(p: Patient): Note[] {
  return p.notes.filter((n) => !n.resolved);
}

export function findPatient(id: string): Patient | undefined {
  return db.patients.find((p) => p.id === id);
}

export function patientCalls(id: string): CallRecord[] {
  return db.calls.filter((c) => c.patientId === id);
}

/** Поиск по имени и всем номерам пациента. */
export function searchPatients(query: string, patients: Patient[] = db.patients): Patient[] {
  const q = query.trim().toLowerCase();
  if (!q) return patients;
  const digits = q.replace(/\D/g, "");
  return patients.filter((p) => {
    if (p.name.toLowerCase().includes(q)) return true;
    if (digits.length >= 2) {
      return p.phones.some((ph) => ph.e164.replace(/\D/g, "").includes(digits));
    }
    return false;
  });
}

// ─────────────────────────────────────────────── мутаторы

function replacePatient(id: string, fn: (p: Patient) => Patient) {
  commit({ ...db, patients: db.patients.map((p) => (p.id === id ? fn(p) : p)) });
}

export function addPatient(input: { name: string; phone: string; source?: string }): Patient {
  const e164 = normalizePhone(input.phone);
  const created: Patient = {
    id: uid("p"),
    name: input.name.trim(),
    bornYear: null,
    firstSeen: "сегодня",
    source: input.source ?? "Вручную",
    channel: "phone",
    phones: e164 ? [phone(e164, { isPrimary: true })] : [],
    notes: [],
    relations: [],
    courses: [],
    visits: [],
    messages: [],
  };
  commit({ ...db, patients: [created, ...db.patients] });
  return created;
}

export function updatePatient(id: string, patch: Partial<Pick<Patient, "name" | "bornYear" | "source">>) {
  replacePatient(id, (p) => ({ ...p, ...patch }));
}

export function removePatient(id: string) {
  commit({
    ...db,
    patients: db.patients
      .filter((p) => p.id !== id)
      // Чистим родственные ссылки на удалённого — иначе повиснут.
      .map((p) => ({ ...p, relations: p.relations.filter((r) => r.relatedPatientId !== id) })),
    calls: db.calls.map((c) => (c.patientId === id ? { ...c, patientId: null } : c)),
  });
}

/** Добавить номер. Возвращает false, если номер не распознан. */
export function addPhone(patientId: string, raw: string): boolean {
  const e164 = normalizePhone(raw);
  if (!e164) return false;
  replacePatient(patientId, (p) => {
    if (p.phones.some((ph) => ph.e164 === e164)) return p;
    const isFirst = p.phones.length === 0;
    return { ...p, phones: [...p.phones, phone(e164, { isPrimary: isFirst })] };
  });
  return true;
}

export function removePhone(patientId: string, phoneId: string) {
  replacePatient(patientId, (p) => {
    const rest = p.phones.filter((ph) => ph.id !== phoneId);
    // Если удалили основной — назначаем основным первый оставшийся.
    if (rest.length > 0 && !rest.some((ph) => ph.isPrimary)) rest[0] = { ...rest[0], isPrimary: true };
    return { ...p, phones: rest };
  });
}

export function setPrimaryPhone(patientId: string, phoneId: string) {
  replacePatient(patientId, (p) => ({
    ...p,
    phones: p.phones.map((ph) => ({ ...ph, isPrimary: ph.id === phoneId })),
  }));
}

export function toggleWhatsapp(patientId: string, phoneId: string) {
  replacePatient(patientId, (p) => ({
    ...p,
    phones: p.phones.map((ph) => (ph.id === phoneId ? { ...ph, whatsapp: !ph.whatsapp } : ph)),
  }));
}

export function addNote(patientId: string, kind: NoteKind, text: string) {
  replacePatient(patientId, (p) => ({
    ...p,
    notes: [...p.notes, { id: uid("n"), kind, text: text.trim(), createdAt: "сегодня", resolved: false }],
  }));
}

export function resolveNote(patientId: string, noteId: string) {
  replacePatient(patientId, (p) => ({
    ...p,
    notes: p.notes.map((n) => (n.id === noteId ? { ...n, resolved: true } : n)),
  }));
}

export function addRelation(patientId: string, relatedPatientId: string, kind: RelationKind) {
  if (patientId === relatedPatientId) return;
  replacePatient(patientId, (p) => {
    if (p.relations.some((r) => r.relatedPatientId === relatedPatientId)) return p;
    return { ...p, relations: [...p.relations, { id: uid("r"), relatedPatientId, kind }] };
  });
}

export function removeRelation(patientId: string, relationId: string) {
  replacePatient(patientId, (p) => ({
    ...p,
    relations: p.relations.filter((r) => r.id !== relationId),
  }));
}

/**
 * Занести звонок. Звонок — обращение наравне с сообщением (§3.4): привязываем к
 * пациенту по номеру, если найден; иначе можно завести нового. Возвращает id
 * пациента, если удалось связать.
 */
export function logCall(input: {
  phone: string;
  direction: "in" | "out";
  serviceInterest?: string | null;
  source?: string | null;
  note?: string;
  patientId?: string | null;
  createNamed?: string; // если задано и пациент не найден — создать с этим именем
}): { callId: string; patientId: string | null } {
  const e164 = normalizePhone(input.phone) ?? input.phone;
  let patientId = input.patientId ?? null;

  if (!patientId) {
    const match = db.patients.find((p) => p.phones.some((ph) => ph.e164 === e164));
    if (match) patientId = match.id;
  }

  let patients = db.patients;
  if (!patientId && input.createNamed && input.createNamed.trim().length > 0) {
    const created: Patient = {
      id: uid("p"),
      name: input.createNamed.trim(),
      bornYear: null,
      firstSeen: "сегодня",
      source: input.source ?? "Звонок",
      channel: "phone",
      phones: normalizePhone(input.phone) ? [phone(e164, { isPrimary: true })] : [],
      notes: [],
      relations: [],
      courses: [],
      visits: [],
      messages: [],
    };
    patients = [created, ...patients];
    patientId = created.id;
  }

  const call: CallRecord = {
    id: uid("call"),
    at: "только что",
    patientId,
    phone: normalizePhone(input.phone) ? formatPhone(e164) : input.phone,
    direction: input.direction,
    serviceInterest: input.serviceInterest ?? null,
    source: input.source ?? null,
    note: (input.note ?? "").trim(),
  };
  commit({ ...db, patients, calls: [call, ...db.calls] });
  return { callId: call.id, patientId };
}

// ─────────────────────────────────────────────── диалоги

function replaceDialog(id: string, fn: (d: Dialog) => Dialog) {
  commit({ ...db, dialogs: db.dialogs.map((d) => (d.id === id ? fn(d) : d)) });
}

/** Отправить ответ вручную. Диалог переходит к человеку, черновик снимается. */
export function sendMessage(dialogId: string, text: string) {
  const t = text.trim();
  if (!t) return;
  replaceDialog(dialogId, (d) => ({
    ...d,
    messages: [...d.messages, { id: uid("m"), from: "staff", text: t, at: "сейчас" }],
    status: d.status === "closed" ? "human" : "human",
    unread: false,
    preview: t,
    agentDraft: undefined,
  }));
}

export function markDialogRead(dialogId: string) {
  replaceDialog(dialogId, (d) => ({ ...d, unread: false }));
}

/** Начать диалог. Если окно закрыто, первым сообщением идёт только шаблон. */
export function startDialog(input: {
  channel: DialogChannel;
  name: string;
  patientId: string | null;
  message: string;
}): string {
  const id = uid("d");
  const dialog: Dialog = {
    id,
    name: input.name,
    channel: input.channel,
    patientId: input.patientId,
    status: "human",
    preview: input.message,
    at: "сейчас",
    unread: false,
    windowOpen: true,
    windowMinutesLeft: null,
    messages: [{ id: uid("m"), from: "staff", text: input.message, at: "сейчас" }],
  };
  commit({ ...db, dialogs: [dialog, ...db.dialogs] });
  return id;
}
