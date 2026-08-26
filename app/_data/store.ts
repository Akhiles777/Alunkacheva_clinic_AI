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
import { reportMaybeStale } from "@/lib/client/stale-build";
import {
  addNoteDb,
  addPhoneDb,
  addRelationDb,
  createPatient,
  removePhoneDb,
  removeRelationDb,
  resolveNoteDb,
  setPrimaryPhoneDb,
  softDeletePatient,
  toggleWhatsappDb,
  updatePatientDb,
  type PatientRecord,
} from "@/app/(dashboard)/patients/actions";
import {
  returnToBotDb,
  markDialogReadDb,
  sendMessageDb,
  startDialogDb,
  type DialogRecord,
} from "@/app/(dashboard)/inbox/actions";
import {
  createAppointmentDb,
  rescheduleApptDb,
  setApptNoteDb,
  setApptStatusDb,
} from "@/app/(dashboard)/schedule/actions";

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
  /** Сеансы, которые СОСТОЯЛИСЬ. */
  used: number;
  total: number;
  /**
   * Записан, но ещё не пришёл: место в курсе занято, сеанс не пройден.
   *
   * Пока планируемые сеансы считались пройденными, курс из десяти показывал
   * «10/10, курс пройден» у пациентки, сходившей четыре раза и записанной на
   * оставшиеся шесть. Администратор видит закрытый курс и дальше человека не
   * зовёт — а звать надо.
   */
  booked?: number;
  status: "active" | "stalled" | "done";
  lastVisit: string;
  /** Сколько суток назад был последний сеанс; null — сеансов ещё не было. */
  daysAgo?: number | null;
  /** Появилась будущая запись — курс уходит из «выпавших». Задаётся при записи. */
  hasFuture?: boolean;
  /**
   * Цена одного сеанса — из самого курса, а не из таблицы в коде.
   *
   * Здесь стоял зашитый прайс с названиями услуг, которых у клиники нет
   * («IV-терапия, экспресс»), и всё, что в него не попадало, оценивалось в
   * 5 000 ₽. На экране это выглядело как деньги, посчитанные по данным.
   */
  pricePerSession?: number;
}

export interface Appt {
  id: string;
  /** null — кабинет не назначен. Подставлять первый нельзя: см. schedule/actions. */
  roomId: string | null;
  roomName: string;
  doctor: string;
  /**
   * Специалист, выбранный в форме. Имя показываем, а связываем по id: тёзок и
   * однофамильцев по имени не различить.
   */
  staffId?: string | null;
  service: string;
  patientId: string | null;
  patientName: string;
  startMinute: number;
  durationMin: number;
  status: "planned" | "confirmed" | "arrived" | "no_show";
  isFirstVisit: boolean;
  /** Цена визита (по умолчанию — цена услуги из настроек, можно изменить). */
  price?: number;
  /** Откуда сумма: подарок, сеанс курса и незаполненная цена — разные нули. */
  amountSource?: "RECORD" | "PRICE_LIST" | "PREPAID" | "FREE" | "UNKNOWN";
  /** Сеанс курса: какой по счёту и сколько всего оплачено. */
  courseSession?: { index: number; total: number } | null;
  /**
   * Услуга визита — курсовая.
   *
   * Нужно, чтобы отличить «сеанс оплаченного курса» от «курсового приёма, за
   * который взяли деньги отдельно». Второе выглядит на экране как обычная
   * сумма, и владелец спрашивает: «БОС-терапия за 2 800 ₽? Это же курс».
   * Ответ бывает верным — сеанс сверх курса или разовый приём оплачивают
   * отдельно, — но экран обязан назвать это сам, а не отправлять проверять
   * руками в YCLIENTS.
   */
  courseService?: boolean;
  /**
   * Состав визита: у каждой услуги своя стоимость.
   *
   * Разрез по услугам считается по нему, а не по основной услуге: у записи
   * основная одна, а услуг в ней бывает несколько.
   */
  parts?: { title: string; amount: number }[];
  /** «Дополнительно»: отзыв клиента, проблема, примечание. Анализируется ИИ. */
  note?: string | null;
  /**
   * Кто записал, если это не сам посетитель: родитель записывает ребёнка,
   * супруг — супругу. Администратору важно знать, кому звонить, а на приём
   * придёт другой человек.
   */
  bookedByName?: string | null;
}
export interface Visit {
  id: string;
  /** Подпись для человека: «12 марта 2026 г.». */
  date: string;
  /** Та же дата машинным форматом — по ней считается аналитика карточки. */
  at?: string;
  service: string;
  doctor: string;
  status: "arrived" | "no_show" | "cancelled" | "planned";
  amount: number;
  /** Откуда сумма: подарок, сеанс курса и незаполненная цена — разные нули. */
  amountSource?: "RECORD" | "PRICE_LIST" | "PREPAID" | "FREE" | "UNKNOWN";
  /** Сеанс курса: какой по счёту и сколько всего оплачено. */
  courseSession?: { index: number; total: number } | null;
  /**
   * Услуга визита — курсовая.
   *
   * Нужно, чтобы отличить «сеанс оплаченного курса» от «курсового приёма, за
   * который взяли деньги отдельно». Второе выглядит на экране как обычная
   * сумма, и владелец спрашивает: «БОС-терапия за 2 800 ₽? Это же курс».
   * Ответ бывает верным — сеанс сверх курса или разовый приём оплачивают
   * отдельно, — но экран обязан назвать это сам, а не отправлять проверять
   * руками в YCLIENTS.
   */
  courseService?: boolean;
  /** Оплачен раньше (курс, абонемент) — в записи дня ноль, но деньги были. */
  paidEarlier?: boolean;
  /** Покупка курса — событие пациента, но не приём. */
  kind?: "visit" | "purchase";
}
/** Вложение сообщения: голосовое, фотография, документ. */
export interface MessageAttachment {
  kind: string;
  label: string;
  /** Адрес в /api/media; пусто у геопозиции и контакта — файла нет. */
  href: string | null;
  mimeType?: string;
  fileName?: string;
  durationSec?: number;
}

export interface Message {
  id: string;
  from: "patient" | "staff" | "bot";
  text: string;
  at: string;
  attachments: MessageAttachment[];
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
  /** Дата первого обращения, машинным форматом. */
  firstSeenAt?: string;
  /** Где пациент в своём пути: ещё не приходил / первичный / повторный. */
  visitStage?: "new" | "primary" | "repeat";
  source: string;
  channel: Channel;
  phones: Phone[];
  notes: Note[];
  relations: Relation[];
  courses: Course[];
  visits: Visit[];
  messages: Message[];
}

export type DialogChannel = "instagram" | "whatsapp" | "telegram";
export type DialogStatus = "bot" | "escalated" | "human" | "closed";

export interface Dialog {
  id: string;
  name: string;
  channel: DialogChannel;
  patientId: string | null;
  /** Номер, с которого пишет пациент: в WhatsApp он известен всегда. */
  phone: string | null;
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
  /** Сообщений в переписке всего. Больше загруженных — значит история длиннее. */
  totalMessages?: number;
}

export interface DB {
  patients: Patient[];
  calls: CallRecord[];
  dialogs: Dialog[];
  appointments: Appt[];
}

// ─────────────────────────────────────────────── seed

let seq = 1000;
/**
 * Идентификатор для новой строки. Обязательно случайный, а не порядковый:
 * счётчик сбрасывается при каждой загрузке страницы, и второй ответ в диалоге
 * получал id, уже занятый в базе, — запись падала на уникальном ключе, а
 * администратор видел «не удалось отправить» без объяснения.
 */
function uid(prefix: string): string {
  seq += 1;
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${seq}-${rand}`;
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

/**
 * Пустое начальное состояние.
 *
 * Здесь раньше лежали выдуманные пациенты и диалоги (Гринберг, Белов,
 * Чернышёва). Они рисовались до загрузки настоящих данных и оставались на
 * экране, если загрузка не дошла, — администратор видел в инбоксе людей,
 * которых в клинике нет. Настоящие данные приходят гидрацией из БД.
 */
const INITIAL: DB = {
  patients: [],
  calls: [],
  dialogs: [],
  appointments: [],
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
/**
 * Серверный снимок — всегда исходный INITIAL (стабильная ссылка). SSR и первый
 * клиентский рендер видят одинаковые данные, поэтому гидрация не расходится;
 * затем стор обновляется данными из БД уже после гидрации.
 */
function getServerSnapshot(): DB {
  return INITIAL;
}

/** Реактивное чтение стора в клиентских компонентах. */
export function useDb(): DB {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Разовое чтение без подписки. */
export function getDb(): DB {
  return db;
}

/**
 * Гидрация пациентов из БД (§4 — единый источник правды). Идентичность,
 * телефоны, заметки и связи берём из БД; курсы/визиты/переписку сохраняем из
 * текущего стора (мигрируют со своими подсистемами). Пациенты, которых в БД нет
 * (мягко удалённые), из стора уходят.
 */
/**
 * Обновить пациентов в сторе.
 *
 * Записи ДОБАВЛЯЮТСЯ к тем, что уже есть, а не заменяют их. Прежде список
 * пересобирался из переданных записей целиком: карточка догружала одного
 * пациента — и в списке оставался он один, до перезагрузки страницы. Пустой
 * список пациентов при полутора тысячах в базе выглядит как потеря данных, и
 * администратор справедливо считает, что платформа сломалась.
 */
export function hydratePatients(records: PatientRecord[]) {
  const byId = new Map(db.patients.map((p) => [p.id, p]));
  const patients: Patient[] = records.map((r) => {
    const existing = byId.get(r.id);
    const phones: Phone[] = r.phones.map((ph) => ({
      id: ph.id,
      e164: ph.e164,
      pretty: formatPhone(ph.e164),
      label: ph.label,
      isPrimary: ph.isPrimary,
      whatsapp: ph.whatsapp,
    }));
    const notes: Note[] = r.notes.map((n) => ({
      id: n.id,
      kind: n.kind,
      text: n.text,
      createdAt: existing?.notes.find((x) => x.id === n.id)?.createdAt ?? "сегодня",
      resolved: n.resolved,
    }));
    const relations: Relation[] = r.relations.map((rl) => ({
      id: rl.id,
      relatedPatientId: rl.relatedPatientId,
      kind: rl.kind,
    }));
    /**
     * История визитов приходит только с карточкой пациента: в списке её не
     * запрашивают, чтобы не тянуть тысячи строк. Поэтому отсутствие поля
     * означает «не спрашивали», а не «визитов нет», — иначе открытая карточка
     * теряла бы историю при обновлении списка.
     */
    const visits: Visit[] = r.visits ?? existing?.visits ?? [];

    if (existing) {
      return {
        ...existing,
        firstSeenAt: r.firstSeenAt ?? existing.firstSeenAt,
        visitStage: r.visitStage ?? existing.visitStage,
        name: r.name || existing.name,
        source: r.source ?? existing.source,
        phones,
        notes,
        relations,
        visits,
      };
    }
    return {
      id: r.id,
      name: r.name,
      bornYear: null,
      firstSeen: r.firstSeenToday ? "сегодня" : "ранее",
      firstSeenAt: r.firstSeenAt,
      visitStage: r.visitStage,
      source: r.source ?? "—",
      channel: "phone",
      phones,
      notes,
      relations,
      courses: [],
      visits,
      messages: [],
    };
  });
  /**
   * Пришедшие записи кладём поверх прежних, порядок сохраняем: список
   * отсортирован сервером, и переставлять его от того, что открыли карточку,
   * нельзя.
   */
  const updated = new Map(patients.map((p) => [p.id, p]));
  const merged = db.patients.map((p) => updated.get(p.id) ?? p);
  for (const p of patients) if (!byId.has(p.id)) merged.push(p);

  commit({ ...db, patients: merged });
}

/**
 * Гидрация диалогов из БД (Conversation + Message). Ядро — сообщения, статус,
 * пациент, канал — из БД; UI-поля (черновик агента, таймер окна, причина
 * эскалации, «непрочитано») сохраняем из текущего диалога по id.
 */
export function hydrateDialogs(records: DialogRecord[]) {
  const byId = new Map(db.dialogs.map((d) => [d.id, d]));
  const dialogs: Dialog[] = records.map((r) => {
    const existing = byId.get(r.id);
    const messages: Message[] = r.messages.map((m) => ({
      id: m.id,
      from: m.from,
      text: m.text,
      at: m.at,
      attachments: m.attachments ?? [],
    }));
    return {
      id: r.id,
      name: r.name ?? existing?.name ?? "Без имени",
      channel: r.channel,
      patientId: r.patientId,
      phone: r.phone,
      status: r.status,
      preview: r.preview,
      at: r.at,
      // Состояние берём с сервера: раньше оно бралось из мока и для диалогов
      // из базы всегда было пустым — фильтр «Нужен ответ» не находил ничего.
      unread: r.unread,
      escalationReason: r.escalationReason ?? undefined,
      agentDraft: existing?.agentDraft,
      windowOpen: r.windowOpen,
      windowMinutesLeft: r.windowMinutesLeft,
      totalMessages: r.totalMessages,
      messages,
    };
  });
  commit({ ...db, dialogs });
}

/** Гидрация расписания из БД (проекция Appointment) — единый источник. */
export function hydrateAppointments(appts: Appt[]) {
  commit({ ...db, appointments: appts });
}

/**
 * Курсы пациентов из базы.
 *
 * Приходят отдельным списком, а не внутри карточки: курс нужен экранам, где
 * карточка не открыта — «Курсы», аналитика пациентов, строка «выпали из курса»
 * на «Сегодня». Раньше все они читали пустой список и молча ничего не
 * показывали.
 */
export function hydrateCourses(records: (Course & { patientId: string })[]) {
  const byPatient = new Map<string, Course[]>();
  for (const { patientId, ...course } of records) {
    byPatient.set(patientId, [...(byPatient.get(patientId) ?? []), course]);
  }
  commit({
    ...db,
    patients: db.patients.map((p) => ({ ...p, courses: byPatient.get(p.id) ?? [] })),
  });
}

// ─────────────────────────────────────────────── производные

export function primaryPhone(p: Patient): Phone | null {
  return p.phones.find((ph) => ph.isPrimary) ?? p.phones[0] ?? null;
}

export function patientTags(p: Patient): string[] {
  const tags: string[] = [];
  /**
   * Метка пути — по состоявшимся визитам, а не по дате контакта. Прежде у
   * пациента, пришедшего не сегодня, метки не было вовсе: ни «первичный», ни
   * «повторный», пустое место в карточке и в списке.
   */
  if (p.visitStage === "primary") tags.push("первичный");
  else if (p.visitStage === "repeat") tags.push("повторный");
  else if (p.visitStage === "new") tags.push("без визитов");
  else if (p.firstSeen === "сегодня") tags.push("первичный");
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

/**
 * Что делать, когда запись в базу не удалась.
 *
 * Все изменения здесь идут «сквозь»: сначала меняется экран, затем база. Пока
 * неудачу гасил пустой `catch`, экран оставался с изменением, которого в базе
 * нет, — отметка «пришёл» не доезжала, а выручка считалась по базе. Теперь
 * такая неудача видна человеку, а не только в консоли браузера.
 *
 * В сообщение попадает только действие и причина: ни имён, ни телефонов, ни
 * текстов сообщений (§7).
 */
export function writeFailed(action: string): (e: unknown) => void {
  return (e: unknown) => {
    const reason = (e as Error)?.message ?? String(e);
    console.error(`[запись] ${action}: ${reason}`);
    // Не сохранилось из-за старой сборки — вкладку надо обновить, а не
    // повторять действие: следующее упадёт так же.
    reportMaybeStale(e);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("clinic:write-failed", { detail: { action, reason } }));
    }
  };
}

function replacePatient(id: string, fn: (p: Patient) => Patient) {
  commit({ ...db, patients: db.patients.map((p) => (p.id === id ? fn(p) : p)) });
}

export function addPatient(input: { name: string; phone: string; source?: string }): Patient {
  const e164 = normalizePhone(input.phone);
  const ph = e164 ? phone(e164, { isPrimary: true }) : null;
  const created: Patient = {
    id: uid("p"),
    name: input.name.trim(),
    bornYear: null,
    firstSeen: "сегодня",
    source: input.source ?? "Вручную",
    channel: "phone",
    phones: ph ? [ph] : [],
    notes: [],
    relations: [],
    courses: [],
    visits: [],
    messages: [],
  };
  commit({ ...db, patients: [created, ...db.patients] });
  void createPatient({
    id: created.id,
    name: created.name,
    source: input.source ?? null,
    phoneId: ph?.id,
    e164: e164 ?? null,
  }).catch(writeFailed("не удалось завести карточку пациента"));
  return created;
}

export function updatePatient(id: string, patch: Partial<Pick<Patient, "name" | "bornYear" | "source">>) {
  replacePatient(id, (p) => ({ ...p, ...patch }));
  if (patch.name !== undefined || patch.source !== undefined) {
    void updatePatientDb(id, { name: patch.name, source: patch.source }).catch(
      writeFailed("не удалось сохранить карточку пациента"),
    );
  }
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
  void softDeletePatient(id).catch(writeFailed("не удалось удалить карточку пациента"));
}

/** Добавить номер. Возвращает false, если номер не распознан. */
export function addPhone(patientId: string, raw: string): boolean {
  const e164 = normalizePhone(raw);
  if (!e164) return false;
  const p = findPatient(patientId);
  if (p?.phones.some((ph) => ph.e164 === e164)) return true;
  const isFirst = (p?.phones.length ?? 0) === 0;
  const ph = phone(e164, { isPrimary: isFirst });
  replacePatient(patientId, (cur) =>
    cur.phones.some((x) => x.e164 === e164) ? cur : { ...cur, phones: [...cur.phones, ph] },
  );
  void addPhoneDb({ id: ph.id, patientId, e164, isPrimary: isFirst }).catch(
    writeFailed("не удалось добавить номер"),
  );
  return true;
}

export function removePhone(patientId: string, phoneId: string) {
  const p = findPatient(patientId);
  if (!p) return;
  const rest = p.phones.filter((ph) => ph.id !== phoneId);
  let newPrimaryId: string | null = null;
  if (rest.length > 0 && !rest.some((ph) => ph.isPrimary)) newPrimaryId = rest[0].id;
  replacePatient(patientId, (cur) => {
    const r = cur.phones.filter((ph) => ph.id !== phoneId);
    if (r.length > 0 && !r.some((ph) => ph.isPrimary)) r[0] = { ...r[0], isPrimary: true };
    return { ...cur, phones: r };
  });
  void removePhoneDb(phoneId, newPrimaryId).catch(writeFailed("не удалось убрать номер"));
}

export function setPrimaryPhone(patientId: string, phoneId: string) {
  replacePatient(patientId, (p) => ({
    ...p,
    phones: p.phones.map((ph) => ({ ...ph, isPrimary: ph.id === phoneId })),
  }));
  void setPrimaryPhoneDb(patientId, phoneId).catch(writeFailed("не удалось сменить основной номер"));
}

export function toggleWhatsapp(patientId: string, phoneId: string) {
  const p = findPatient(patientId);
  const next = !p?.phones.find((ph) => ph.id === phoneId)?.whatsapp;
  replacePatient(patientId, (cur) => ({
    ...cur,
    phones: cur.phones.map((ph) => (ph.id === phoneId ? { ...ph, whatsapp: !ph.whatsapp } : ph)),
  }));
  void toggleWhatsappDb(phoneId, next).catch(writeFailed("не удалось отметить WhatsApp у номера"));
}

export function addNote(patientId: string, kind: NoteKind, text: string) {
  const note: Note = { id: uid("n"), kind, text: text.trim(), createdAt: "сегодня", resolved: false };
  replacePatient(patientId, (p) => ({ ...p, notes: [...p.notes, note] }));
  void addNoteDb({ id: note.id, patientId, kind, text: note.text }).catch(
    writeFailed("не удалось сохранить пометку"),
  );
}

export function resolveNote(patientId: string, noteId: string) {
  replacePatient(patientId, (p) => ({
    ...p,
    notes: p.notes.map((n) => (n.id === noteId ? { ...n, resolved: true } : n)),
  }));
  void resolveNoteDb(noteId).catch(writeFailed("не удалось снять пометку"));
}

export function addRelation(patientId: string, relatedPatientId: string, kind: RelationKind) {
  if (patientId === relatedPatientId) return;
  const p = findPatient(patientId);
  if (p?.relations.some((r) => r.relatedPatientId === relatedPatientId)) return;
  const rel: Relation = { id: uid("r"), relatedPatientId, kind };
  replacePatient(patientId, (cur) =>
    cur.relations.some((r) => r.relatedPatientId === relatedPatientId)
      ? cur
      : { ...cur, relations: [...cur.relations, rel] },
  );
  void addRelationDb({ id: rel.id, patientId, relatedPatientId, kind }).catch(
    writeFailed("не удалось связать карточки"),
  );
}

export function removeRelation(patientId: string, relationId: string) {
  replacePatient(patientId, (p) => ({
    ...p,
    relations: p.relations.filter((r) => r.id !== relationId),
  }));
  void removeRelationDb(relationId).catch(writeFailed("не удалось убрать связь карточек"));
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
/**
 * Отправить ответ пациенту. Возвращает промис с результатом доставки: если
 * канал не принял сообщение, интерфейс обязан это показать — иначе
 * администратор уверен, что ответил, а пациент ничего не получил.
 */
export function sendMessage(dialogId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const t = text.trim();
  if (!t) return Promise.resolve({ ok: false, error: "Пустое сообщение" });
  // Сотрудник отправляет текст: вложения из интерфейса пока не отправляются.
  const msg: Message = { id: uid("m"), from: "staff", text: t, at: "сейчас", attachments: [] };
  replaceDialog(dialogId, (d) => ({
    ...d,
    messages: [...d.messages, msg],
    status: "human",
    unread: false,
    preview: t,
    agentDraft: undefined,
  }));
  return sendMessageDb(dialogId, msg.id, t).catch(() => ({
    ok: false,
    error: "Не удалось связаться с сервером",
  }));
}

/** Вернуть диалог агенту: снять паузу и закрыть эскалацию. */
export function returnToBot(dialogId: string) {
  replaceDialog(dialogId, (d) => ({ ...d, status: "bot", escalationReason: undefined }));
  void returnToBotDb(dialogId).catch(writeFailed("не удалось вернуть диалог агенту"));
}

/**
 * Диалог прочитан.
 *
 * Отметку нужно сохранить на сервере, а не только на экране: список тянется
 * заново каждые несколько секунд, и «непрочитано» возвращалось вместе с ним.
 * Фиолетовая точка гасла на мгновение и загоралась снова — администратор
 * перестал на неё смотреть.
 */
export function markDialogRead(dialogId: string) {
  replaceDialog(dialogId, (d) => ({ ...d, unread: false }));
  void markDialogReadDb(dialogId).catch(writeFailed("не удалось отметить диалог прочитанным"));
}

/** Начать диалог. Если окно закрыто, первым сообщением идёт только шаблон. */
export function startDialog(input: {
  channel: DialogChannel;
  name: string;
  patientId: string | null;
  message: string;
}): string {
  const id = uid("d");
  const messageId = uid("m");
  const dialog: Dialog = {
    id,
    name: input.name,
    channel: input.channel,
    patientId: input.patientId,
    // Диалог, заведённый из звонка: номер известен из карточки, а не из канала.
    phone: null,
    status: "human",
    preview: input.message,
    at: "сейчас",
    unread: false,
    windowOpen: true,
    windowMinutesLeft: null,
    messages: [{ id: messageId, from: "staff", text: input.message, at: "сейчас", attachments: [] }],
  };
  commit({ ...db, dialogs: [dialog, ...db.dialogs] });
  void startDialogDb({
    id,
    messageId,
    channel: input.channel,
    patientId: input.patientId,
    message: input.message,
  }).catch(writeFailed("не удалось начать диалог"));
  return id;
}

// ─────────────────────────────────────────────── курсы (плоский список)

function daysSince(label: string): number | null {
  if (label === "сегодня") return 0;
  const m = /(\d+)\s+дн/.exec(label);
  return m ? Number(m[1]) : null;
}

export interface CourseView {
  patientId: string;
  patientName: string;
  channel: Channel;
  courseId: string;
  title: string;
  /** Сеансы, которые состоялись. */
  used: number;
  total: number;
  /** Не пройдено: по этим сеансам клиника ещё не отработала деньги. */
  remaining: number;
  /** Записан, но ещё не пришёл. */
  booked: number;
  /**
   * Сеансы, на которые пациент ещё НЕ записан.
   *
   * Именно это число отвечает на вопрос «кого звать». «Осталось 6» при шести
   * уже назначенных приёмах — повод для звонка человеку, который и так придёт
   * завтра.
   */
  toBook: number;
  status: Course["status"];
  lastVisit: string;
  daysAgo: number | null;
  hasFuture: boolean;
  moneyLeft: number;
  stalled: boolean;
  onFinish: boolean;
}

/** Плоский список курсов по всем пациентам с деньгами в остатке. */
/**
 * Курсы всех пациентов.
 *
 * Принимает список пациентов, а не читает модульный `db`: при рендере нужно
 * брать ровно тот снимок, что вернул useDb(). Иначе SSR считает по исходным
 * данным, а клиент к моменту гидратации уже видит подставленные из БД —
 * React ловит расхождение и перерисовывает поддерево заново.
 */
export function allCourses(patients: Patient[] = db.patients): CourseView[] {
  const out: CourseView[] = [];
  for (const p of patients) {
    for (const c of p.courses) {
      const remaining = Math.max(c.total - c.used, 0);
      const booked = c.booked ?? 0;
      const toBook = Math.max(remaining - booked, 0);
      const hasFuture = c.hasFuture ?? c.status !== "stalled";
      const price = c.pricePerSession ?? 0;
      out.push({
        patientId: p.id,
        patientName: p.name,
        channel: p.channel,
        courseId: c.id,
        title: c.title,
        used: c.used,
        total: c.total,
        remaining,
        booked,
        toBook,
        status: c.status,
        lastVisit: c.lastVisit,
        daysAgo: c.daysAgo ?? daysSince(c.lastVisit),
        hasFuture,
        moneyLeft: remaining * price,
        stalled: c.status === "stalled" && !hasFuture,
        // «Пора дозаписать» — про НЕзаписанные сеансы. Иначе экран звал бы
        // пациента, у которого оставшиеся приёмы уже стоят в расписании.
        onFinish: c.status === "active" && toBook > 0 && toBook <= 2,
      });
    }
  }
  return out;
}

/** Курс получил будущую запись — уходит из «выпавших». */
export function setCourseBooked(patientId: string, courseId: string) {
  replacePatient(patientId, (p) => ({
    ...p,
    courses: p.courses.map((c) =>
      c.id === courseId ? { ...c, hasFuture: true, status: c.status === "stalled" ? "active" : c.status } : c,
    ),
  }));
}

// ─────────────────────────────────────────────── расписание

function replaceAppt(id: string, fn: (a: Appt) => Appt) {
  commit({ ...db, appointments: db.appointments.map((a) => (a.id === id ? fn(a) : a)) });
}

export function markArrived(id: string) {
  replaceAppt(id, (a) => ({ ...a, status: "arrived" }));
  void setApptStatusDb(id, "arrived").catch(writeFailed("отметка «пришёл» не сохранена"));
}
/** Заметка по визиту после приёма. Её разбирает ИИ-аналитик владельца. */
export function setApptNote(id: string, note: string) {
  replaceAppt(id, (a) => ({ ...a, note: note.trim() || null }));
  void setApptNoteDb(id, note).catch(writeFailed("заметка по визиту не сохранена"));
}
export function markNoShow(id: string) {
  replaceAppt(id, (a) => ({ ...a, status: "no_show" }));
  void setApptStatusDb(id, "no_show").catch(writeFailed("отметка «не пришёл» не сохранена"));
}
export function rescheduleAppt(id: string, startMinute: number) {
  replaceAppt(id, (a) => ({ ...a, startMinute }));
  void rescheduleApptDb(id, startMinute).catch(writeFailed("перенос визита не сохранён"));
}
/**
 * Создать запись.
 *
 * `onError` обязателен по смыслу, а не по типу: раньше неудача записи в базу
 * гасилась пустым `catch`, и запись оставалась только на экране. Администратор
 * видел её в расписании, в YCLIENTS её не было — а значит, время считалось
 * свободным, и в него ставили второго пациента.
 */
export function addAppt(
  input: Omit<Appt, "id" | "status" | "isFirstVisit"> & { status?: Appt["status"] },
  onError?: (message: string) => void,
) {
  const appt: Appt = {
    id: uid("a"),
    status: input.status ?? "planned",
    isFirstVisit: false,
    ...input,
  };
  commit({ ...db, appointments: [...db.appointments, appt] });
  void createAppointmentDb({
    id: appt.id,
    // Кабинет — только выбранный. Подстановка первого приписывала запись
    // кабинету, в котором приёма нет, и портила его загрузку.
    roomId: appt.roomId ?? "",
    doctor: appt.doctor,
    staffId: appt.staffId ?? null,
    service: appt.service,
    patientId: appt.patientId,
    patientName: appt.patientName,
    startMinute: appt.startMinute,
    durationMin: appt.durationMin,
    status: appt.status,
    price: appt.price,
    note: appt.note,
    bookedByName: appt.bookedByName,
  }).catch((e: unknown) => {
    // Записи нет в базе — не должно быть и на экране.
    commit({ ...db, appointments: db.appointments.filter((a) => a.id !== appt.id) });
    const message = (e as Error)?.message ?? "не удалось сохранить запись";
    console.error("[запись] не сохранена:", message);
    onError?.(message);
  });
  return appt.id;
}
