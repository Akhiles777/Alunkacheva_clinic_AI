import { readFileSync } from "node:fs";
import { prisma } from "../lib/db";
import { hashPassword } from "../lib/auth";
import { ROLE_MATRIX, type Role } from "../lib/permissions";
import type { Permission, ServiceKind } from "../generated/prisma/enums";
import {
  backfillFirstSeen,
  backfillRooms,
  recomputeAppointmentSources,
  recomputePatientSources,
  recomputeVisitKinds,
} from "../lib/metrics/recompute";
import { linkCourses } from "../lib/courses/link";
import type { RawTransaction } from "../lib/courses/purchases";
import { DEMO_YCLIENTS_ID } from "./demo-id";

/**
 * Демо-стенд для показа заказчику и его клиентам: клиника целиком.
 *
 * Справочники НАСТОЯЩИЕ — из снимка боевой базы (`scripts/agent-export.ts`):
 * прайс, сотрудники, справочник ассистента, его инструкция, график клиники.
 * В снимке нет ни одного пациента, переписки или телефона (§7).
 *
 * Пациенты, визиты, курсы, оплаты — ВЫДУМАННЫЕ, но связные: у врача свой
 * профиль услуг и свои дни, в кабинете визиты не накладываются, курс БОС —
 * продажа в кассе и десять сеансов по нулю, у ребёнка — карточка родителя.
 * Пропорции «врач — услуга» взяты из той же сводки снимка.
 *
 * Производные поля (первичный/повторный, курсы, источники) считает НЕ этот
 * скрипт, а тот же код, что и на боевом сервере после выгрузки: иначе демо
 * показывало бы не то, что увидит клиника.
 *
 * Работает только на пустой базе или на базе, где есть одна эта демо-клиника,
 * и пересоздаёт её целиком. Переписки — отдельный скрипт `demo-dialogs.ts`.
 *
 *   DATABASE_URL=…/clinic_demo npx tsx scripts/demo-build.ts --apply
 */

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "demo2026";

// Детерминированный генератор: один и тот же стенд при каждом прогоне.
let seed = 20261012;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const chance = (p: number) => rnd() < p;
const between = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

// ───────────────────────────────────────────── снимок

interface Snapshot {
  company: { name: string; timezone: string };
  services: {
    id: string;
    yclientsServiceId: number | null;
    title: string;
    kind: ServiceKind;
    price: number;
    durationMin: number;
    isCourse: boolean;
    defaultSessions: number | null;
    stalledAfterDays: number | null;
    isActive: boolean;
  }[];
  staff: { id: string; yclientsStaffId: number | null; name: string; specialty: string | null; sortOrder: number }[];
  knowledge: { topic: string; question: string; answer: string; isActive: boolean; needsDoctorApproval: boolean; approvedAt: string | null }[];
  settings: { key: string; value: unknown }[];
  consent: { version: string; text: string; policyUrl: string | null } | null;
}

function loadSnapshot(): Snapshot {
  const path = process.env.DEMO_SNAPSHOT ?? "data/agent-snapshot.json";
  return JSON.parse(readFileSync(path, "utf8")) as Snapshot;
}

/**
 * Длительность там, где в YCLIENTS стоит ноль: на экране расписания визит без
 * длины — точка, а кабинет с такими визитами выглядит пустым.
 */
function durationFor(title: string, kind: string, given: number): number {
  if (given > 0) return given;
  const t = title.toLowerCase();
  if (t.includes("укол") || t.includes("струйн")) return 15;
  if (t.includes("кров") || t.includes("анализ")) return 15;
  if (t.includes("консультац") || t.includes("диагностик") || t.includes("анкета")) return 30;
  if (t.includes("нак") || t.includes("нейромедит")) return 30;
  if (kind === "BIOFEEDBACK" || t.includes("бос")) return 40;
  // Лотос — «около 45 минут» по справке клиники; длительность не должна с ней расходиться.
  if (t.includes("лотос")) return 45;
  if (t.includes("массаж") || t.includes("бьюти")) return 60;
  if (t.includes("пакет")) return 60;
  return 60;
}

// ───────────────────────────────────────────── выдуманные люди

const FEMALE = ["Патимат", "Мадина", "Аминат", "Зарема", "Хадижат", "Марьям", "Сабина", "Айшат", "Заира", "Диана", "Луиза", "Камила", "Асият", "Джамиля", "Эльмира", "Карина", "Залина", "Саида", "Фатима", "Индира", "Лейла", "Милана", "Альбина", "Самира", "Разиля", "Динара", "Кистаман", "Написат", "Умжат", "Салимат"];
const MALE = ["Магомед", "Ахмед", "Расул", "Шамиль", "Арсен", "Камиль", "Мурад", "Гаджи", "Руслан", "Тимур", "Ислам", "Саид", "Абдула", "Рамазан", "Али", "Заур", "Арслан", "Курбан"];
const SURNAMES = ["Магомедов", "Алиев", "Гаджиев", "Абдуллаев", "Курбанов", "Рамазанов", "Исмаилов", "Ахмедов", "Мусаев", "Халилов", "Гасанов", "Казиев", "Сулейманов", "Шахбанов", "Абакаров", "Юсупов", "Ибрагимов", "Расулов", "Дибиров", "Нурмагомедов", "Хизриев", "Мирзоев", "Зайнулабидов", "Бийболатов", "Айдемиров", "Кадиев", "Пашаев", "Тагиров", "Умаров", "Шамхалов"];
const FATHERS = ["Магомед", "Ахмед", "Расул", "Али", "Гаджи", "Шамиль", "Камил", "Мурад", "Абдула", "Исмаил", "Рамазан", "Саид", "Гасан", "Омар", "Курбан"];

/** Гаджи → Гаджиевна, Шамиль → Шамилевна, Абдула → Абдулаевна, Расул → Расуловна. */
function patronymic(father: string, female: boolean): string {
  if (father.endsWith("ь")) return `${father.slice(0, -1)}${female ? "евна" : "евич"}`;
  if (/[аи]$/.test(father)) return `${father}${female ? "евна" : "евич"}`;
  return `${father}${female ? "овна" : "ович"}`;
}

const usedNames = new Set<string>();
function personName(female: boolean): string {
  for (;;) {
    const sur = pick(SURNAMES);
    const name = `${female ? `${sur}а` : sur} ${female ? pick(FEMALE) : pick(MALE)} ${patronymic(pick(FATHERS), female)}`;
    if (!usedNames.has(name)) {
      usedNames.add(name);
      return name;
    }
  }
}

let phoneSeq = 0;
/** Номера заведомо из одного выдуманного блока: +7 900 7xx-xx-xx. */
function demoPhone(): string {
  phoneSeq += 1;
  return `+79007${String(100000 + phoneSeq * 37).slice(-6)}`;
}

// ───────────────────────────────────────────── время

const TZ_OFFSET_MIN = 180; // Махачкала = Москва, UTC+3
const DAY = 24 * 3600_000;

/** Начало дня клиники (полночь по UTC+3) для даты. */
function clinicMidnight(d: Date): Date {
  const local = new Date(d.getTime() + TZ_OFFSET_MIN * 60_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - TZ_OFFSET_MIN * 60_000);
}
/** День недели клиники: 1 = пн … 7 = вс. */
function weekdayOf(midnight: Date): number {
  const local = new Date(midnight.getTime() + TZ_OFFSET_MIN * 60_000);
  return ((local.getUTCDay() + 6) % 7) + 1;
}
const at = (midnight: Date, minute: number) => new Date(midnight.getTime() + minute * 60_000);

// ───────────────────────────────────────────── основное

async function assertDemoOnly() {
  const companies = await prisma.company.findMany({ select: { id: true, name: true, yclientsId: true } });
  const foreign = companies.filter((c) => c.yclientsId !== DEMO_YCLIENTS_ID);
  for (const c of foreign) {
    const visits = await prisma.appointment.count({ where: { companyId: c.id } });
    const messages = await prisma.message.count({ where: { companyId: c.id } });
    if (visits > 0 || messages > 0) {
      console.error(`В базе есть клиника «${c.name}» с данными (визитов ${visits}, сообщений ${messages}).`);
      console.error("Демо собирается только на пустой базе. Это может быть боевая база — остановлено.");
      process.exit(1);
    }
  }
  return companies;
}

async function wipeDemo() {
  /**
   * Пересоздаём с нуля: стенд должен быть одинаковым при каждом прогоне, а
   * удаление по таблицам здесь хрупко — связей больше шестидесяти. Компания
   * удаляется каскадом со всем, что на неё ссылается.
   */
  const companies = await prisma.company.findMany({ select: { id: true } });
  for (const c of companies) {
    // Ссылки с Restrict идут не на компанию — снимаем их первыми.
    await prisma.appointment.deleteMany({ where: { companyId: c.id } });
    await prisma.course.deleteMany({ where: { companyId: c.id } });
    await prisma.$executeRawUnsafe(`DELETE FROM companies WHERE id = $1`, c.id);
  }
}

interface StaffPlan {
  key: "irina" | "raziyat" | "omarova" | "nuriyat" | "safiya";
  snapName: string;
  room: "osteo1" | "osteo2" | "proc";
  workdays: number[];
  /** Публиковать ли дни приёма агенту. Выдумывать то, чего клиника не называла, нельзя. */
  publishDays: boolean;
}

const STAFF_PLAN: StaffPlan[] = [
  // Так у клиники: по пятницам и субботам из остеопатов принимает только Разият (§6).
  { key: "irina", snapName: "Ирина Алилгаджиевна", room: "osteo1", workdays: [1, 2, 3, 4], publishDays: true },
  { key: "raziyat", snapName: "Мугадова Разият Ризвановна", room: "osteo2", workdays: [1, 2, 3, 4, 5, 6], publishDays: true },
  { key: "omarova", snapName: "Ирина Омарова", room: "osteo2", workdays: [1, 2, 3, 4, 5, 6], publishDays: false },
  { key: "nuriyat", snapName: "Нурият Абулкасимовна", room: "proc", workdays: [1, 3, 5, 6], publishDays: false },
  { key: "safiya", snapName: "Сафия Гаджиевна", room: "proc", workdays: [2, 4], publishDays: false },
];

async function main() {
  if (!process.argv.includes("--apply")) {
    console.log("Сухой прогон: ничего не меняю. Запуск с --apply пересоздаст демо-клинику в этой базе.");
    return;
  }
  await assertDemoOnly();
  await wipeDemo();

  const snap = loadSnapshot();
  const now = new Date();
  const today = clinicMidnight(now);

  const company = await prisma.company.create({
    data: {
      yclientsId: DEMO_YCLIENTS_ID,
      name: snap.company.name,
      timezone: snap.company.timezone,
      dayStartMinute: 8 * 60,
      dayEndMinute: 16 * 60,
      consentPolicyUrl: snap.consent?.policyUrl ?? null,
    },
  });
  const companyId = company.id;
  console.log(`клиника: ${company.name} (${companyId})`);

  // ── источники
  const SOURCES = [
    { code: "whatsapp", title: "WhatsApp", kind: "MESSENGER" as const, sortOrder: 10 },
    { code: "instagram", title: "Instagram", kind: "MESSENGER" as const, sortOrder: 20 },
    { code: "telegram", title: "Telegram", kind: "MESSENGER" as const, sortOrder: 25 },
    { code: "call", title: "Звонок", kind: "PHONE" as const, sortOrder: 30 },
    { code: "site", title: "Сайт", kind: "WEB" as const, sortOrder: 40 },
    { code: "offline", title: "Пришёл сам", kind: "OFFLINE" as const, sortOrder: 50 },
    { code: "referral", title: "Рекомендация", kind: "REFERRAL" as const, sortOrder: 60 },
  ];
  const sourceId: Record<string, string> = {};
  for (const s of SOURCES) {
    sourceId[s.code] = (await prisma.source.create({ data: { companyId, ...s } })).id;
  }

  // ── кабинеты
  const ROOMS = [
    { key: "osteo1", name: "Кабинет 1 — остеопатия", direction: "Остеопатия", sortOrder: 1 },
    { key: "osteo2", name: "Кабинет 2 — остеопатия и БОС", direction: "Остеопатия, БОС-терапия", sortOrder: 2 },
    { key: "proc", name: "Кабинет 3 — процедурный", direction: "IV-терапия, анализы", sortOrder: 3 },
  ] as const;
  const roomId: Record<string, string> = {};
  for (const [i, r] of ROOMS.entries()) {
    roomId[r.key] = (
      await prisma.room.create({
        data: { companyId, name: r.name, direction: r.direction, sortOrder: r.sortOrder, yclientsResourceId: 9100 + i },
      })
    ).id;
  }

  // ── график клиники — из её же настройки: пн–пт 08:00–16:00, сб 09:00–16:00
  const clinicSetting = snap.settings.find((s) => s.key === "clinic")?.value as
    | { schedule?: { enabled: boolean; weekday: number; startMinute: number; endMinute: number }[] }
    | undefined;
  const hours = new Map<number, { start: number; end: number }>();
  for (const d of clinicSetting?.schedule ?? []) {
    if (d.enabled) hours.set(d.weekday, { start: d.startMinute, end: d.endMinute });
  }
  for (const [weekday, h] of hours) {
    await prisma.clinicSchedule.create({
      data: { companyId, weekday, startMinute: h.start, endMinute: h.end, validFrom: new Date("2020-01-01") },
    });
  }
  for (const s of snap.settings) {
    await prisma.setting.create({ data: { companyId, key: s.key, value: s.value as object } });
  }

  // ── услуги: действующий прайс клиники
  const serviceByTitle = new Map<string, { id: string; price: number; durationMin: number; kind: string }>();
  let fakeServiceId = 88_000_000;
  for (const s of snap.services) {
    if (!s.isActive) continue;
    const durationMin = durationFor(s.title, s.kind, s.durationMin);
    const kind: ServiceKind =
      s.kind !== "OTHER"
        ? s.kind
        : /инфузи|капельн|внутривенн|пакет|укол|iv/i.test(s.title)
          ? "IV_THERAPY"
          : /нак|бос/i.test(s.title)
            ? "BIOFEEDBACK"
            : "OTHER";
    const created = await prisma.service.create({
      data: {
        companyId,
        yclientsServiceId: s.yclientsServiceId ?? fakeServiceId++,
        title: s.title,
        kind,
        price: s.price,
        durationMin,
        isCourse: s.isCourse,
        defaultSessions: s.defaultSessions,
        stalledAfterDays: s.stalledAfterDays ?? (s.isCourse ? 14 : null),
      },
    });
    serviceByTitle.set(s.title, { id: created.id, price: s.price, durationMin, kind });
  }
  const svc = (title: string) => {
    const s = serviceByTitle.get(title);
    if (!s) throw new Error(`Нет услуги в снимке: ${title}`);
    return s;
  };

  // ── сотрудники
  const staffId: Record<string, string> = {};
  let fakeStaffId = 99_000_001;
  for (const plan of STAFF_PLAN) {
    const snapStaff = snap.staff.find((s) => s.name === plan.snapName);
    if (!snapStaff) throw new Error(`Нет сотрудника в снимке: ${plan.snapName}`);
    staffId[plan.key] = (
      await prisma.staff.create({
        data: {
          companyId,
          yclientsStaffId: snapStaff.yclientsStaffId ?? fakeStaffId++,
          name: snapStaff.name,
          specialty: snapStaff.specialty,
          defaultRoomId: roomId[plan.room],
          workdays: plan.publishDays ? plan.workdays : [],
          sortOrder: snapStaff.sortOrder,
        },
      })
    ).id;
  }

  // ── услуги ↔ кабинеты (для загрузки и подбора окна)
  for (const [title, s] of serviceByTitle) {
    const rooms =
      s.kind === "OSTEOPATHY" || /остео/i.test(title)
        ? ["osteo1", "osteo2"]
        : s.kind === "BIOFEEDBACK" || s.kind === "NEUROMEDITATION"
          ? ["osteo2"]
          : ["proc"];
    for (const r of rooms) await prisma.serviceRoom.create({ data: { companyId, serviceId: s.id, roomId: roomId[r] } });
  }

  // ── справочник ассистента — дословно как у клиники
  for (const k of snap.knowledge) {
    await prisma.knowledgeEntry.create({
      data: {
        companyId,
        topic: k.topic,
        question: k.question,
        answer: k.answer,
        isActive: k.isActive,
        needsDoctorApproval: k.needsDoctorApproval,
        approvedAt: k.approvedAt ? new Date(k.approvedAt) : null,
      },
    });
  }
  const consentDoc = await prisma.consentDocument.create({
    data: {
      companyId,
      version: snap.consent?.version ?? "1.0",
      text: snap.consent?.text ?? "Согласие на обработку персональных данных",
      policyUrl: snap.consent?.policyUrl ?? null,
      isActive: true,
    },
  });

  // ── права
  const PERMISSIONS: Permission[] = ["VIEW_OTHER_PATIENTS", "VIEW_REVENUE", "EDIT_SETTINGS", "MESSAGE_PATIENTS", "VIEW_AUDIT"];
  for (const role of Object.keys(ROLE_MATRIX) as Role[]) {
    const allowed = new Set(ROLE_MATRIX[role]);
    for (const permission of PERMISSIONS) {
      await prisma.rolePermission.create({ data: { companyId, role, permission, allowed: allowed.has(permission) } });
    }
  }

  // ── учётные записи: прежние логины стенда сохраняются (их хэши), плюс общие демо-входы
  const users: Record<string, string> = {};
  const oldUsersPath = process.env.DEMO_OLD_USERS;
  const oldUsers: { login: string; name: string; role: Role; passwordHash: string; isActive: boolean }[] = oldUsersPath
    ? JSON.parse(readFileSync(oldUsersPath, "utf8"))
    : [];
  const linkStaff: Record<string, string | undefined> = { irina: staffId.irina, razi: staffId.raziyat, omarova: staffId.omarova };
  for (const u of oldUsers) {
    if (!u.isActive) continue;
    users[u.login] = (
      await prisma.staffUser.create({
        data: { companyId, login: u.login, name: u.name, role: u.role, passwordHash: u.passwordHash, staffId: linkStaff[u.login] ?? null },
      })
    ).id;
  }
  // Общие демо-входы. Врачи — прежние логины стенда (irina, razi, omarova), они привязаны к карточкам.
  const DEMO_USERS = [
    { login: "demo", name: "Ирина Алункачева", role: "OWNER" as const },
    { login: "admin", name: "Зарина Магомедова", role: "ADMIN" as const },
    { login: "admin2", name: "Аминат Курбанова", role: "ADMIN" as const },
  ];
  for (const u of DEMO_USERS) {
    if (users[u.login]) continue;
    users[u.login] = (
      await prisma.staffUser.create({
        data: { companyId, login: u.login, name: u.name, role: u.role, passwordHash: hashPassword(DEMO_PASSWORD) },
      })
    ).id;
  }
  const adminIds = [users.admin, users.admin2].filter(Boolean);

  // ───────────────────────────────────────── пациенты и визиты

  const HISTORY_DAYS = 270;
  const AHEAD_DAYS = 21;

  type Segment = "irinaAdult" | "irinaChild" | "razAdult" | "razChild" | "pregnant" | "bos" | "iv" | "lab" | "lotos";
  interface DemoPatient {
    id: string;
    yclientsId: number;
    phone: string;
    segment: Segment;
    female: boolean;
    visits: number;
    maxVisits: number;
    nextDue: number; // мс
    course?: { sessions: number; stopAt: number; perWeek: number; startedAt: number | null; sold: boolean; service: string };
    sourceCode: string | null;
  }

  const patients: DemoPatient[] = [];
  let yclientsPatientSeq = 61_000_000;
  const patientRows: { id: string; name: string; phone: string; female: boolean }[] = [];

  async function newPatient(segment: Segment, firstAt: number): Promise<DemoPatient> {
    const childCard = segment === "irinaChild" || segment === "razChild";
    // Ребёнка записывают на карточку родителя — чаще мамы.
    const female = segment === "pregnant" || childCard ? chance(0.92) : chance(0.72);
    const name = personName(female);
    const phone = demoPhone();
    const yclientsId = ++yclientsPatientSeq;
    const birthYear = segment === "pregnant" ? between(1990, 2001) : childCard ? between(1983, 1999) : between(1962, 2004);
    const sourceCode = chance(0.45)
      ? null // откуда пришёл, выведет код по переписке — или так и останется неизвестным
      : pick(["call", "call", "referral", "referral", "offline", "site", "instagram", "whatsapp"]);
    const firstSeenAt = new Date(firstAt - between(0, 6) * DAY - between(1, 600) * 60_000);
    const created = await prisma.patient.create({
      data: {
        companyId,
        yclientsId,
        name,
        birthDate: new Date(Date.UTC(birthYear, between(0, 11), between(1, 28))),
        firstSeenAt,
        sourceId: sourceCode ? sourceId[sourceCode] : null,
        sourceConfidence: sourceCode ? "MANUAL" : "UNKNOWN",
        createdAt: firstSeenAt,
      },
    });
    await prisma.patientPhone.create({
      data: { companyId, patientId: created.id, phone, isPrimary: true, usedForWhatsapp: true, label: "мобильный" },
    });
    patientRows.push({ id: created.id, name, phone, female });
    const maxVisits =
      segment === "lab" ? between(1, 2) : segment === "iv" ? between(2, 6) : segment === "bos" ? 1 : between(1, segment.endsWith("Child") ? 7 : 5);
    const p: DemoPatient = {
      id: created.id,
      yclientsId,
      phone,
      segment,
      female,
      visits: 0,
      maxVisits,
      nextDue: firstAt,
      sourceCode,
      ...(segment === "bos"
        ? {
            course: {
              sessions: 10,
              // Часть курсов бросают на середине — из них очередь «Кому позвонить».
              stopAt: chance(0.12) ? between(3, 7) : 10,
              perWeek: chance(0.5) ? 3 : 2,
              startedAt: null,
              sold: false,
              // Одна курсовая услуга на курс: две по одной цене — и продажу не отнести ни к одной.
              service: chance(0.15) ? "НАК + БОС" : "БОС-терапия",
            },
          }
        : {}),
    };
    patients.push(p);
    return p;
  }

  /** Кто ведёт сегмент и чем. */
  function servicesFor(seg: Segment, p: DemoPatient): { titles: string[]; staff: StaffPlan["key"] } {
    switch (seg) {
      case "irinaAdult":
        return { titles: ["Остеопатия, приём Ирины"], staff: "irina" };
      case "irinaChild":
        return { titles: ["Остеопатия - дети, прием Ирины"], staff: "irina" };
      case "pregnant":
        return { titles: ["Остеопатия, приём Ирины"], staff: "irina" };
      case "razAdult":
        return { titles: ["Остеопатия, прием Разият"], staff: "raziyat" };
      case "razChild":
        return { titles: ["Остеопатия - дети, прием Разият"], staff: "raziyat" };
      case "bos":
        return {
          titles: p.visits === 0 ? ["Диагностика/консультация на БОС-терапию"] : [p.course?.service ?? "БОС-терапия"],
          staff: "omarova",
        };
      case "iv": {
        if (p.visits === 0) return { titles: ['Анкета - Экспертный аудит и назначение IV-протокола'], staff: chance(0.6) ? "nuriyat" : "safiya" };
        const infusion = pick([
          'Инфузия "Ферро-Баланс" (Энергия крови)',
          'Инфузия "Клеточный баланс" (Иммунитет и антистресс)',
          'Инфузия "Мета-Очищение" (Глобальный детокс и энергия)',
          'Инфузия "Гепато-Ресурс" (Защита печени)',
          'Инфузия "Точка покоя" (Глубокий релакс)',
          'Инфузия "Интеллект-Актив" (Ясный ум)',
          'Инфузия "NAD+Био-Генезис" (Молекула молодости)',
          'Пакет "БАЗА"',
        ]);
        // Инфузия и само введение — две строки одного визита, как пробивает клиника.
        return { titles: infusion.startsWith("Пакет") ? [infusion] : [infusion, "Внутривенное капельное введение растворов (IV-терапия)"], staff: chance(0.6) ? "nuriyat" : "safiya" };
      }
      case "lab":
        return { titles: [chance(0.8) ? "Забор крови" : "Внутримышечный укол"], staff: chance(0.6) ? "nuriyat" : "safiya" };
      case "lotos":
        return { titles: ["Лотос/Стандарт"], staff: "nuriyat" };
    }
  }

  /** Насколько плотно занят врач: доля слотов с записью, а доля новых — среди них. */
  const LOAD: Record<StaffPlan["key"], { fill: number; segments: [Segment, number][] }> = {
    irina: { fill: 0.78, segments: [["irinaChild", 0.6], ["irinaAdult", 0.32], ["pregnant", 0.08]] },
    raziyat: { fill: 0.62, segments: [["razAdult", 0.55], ["razChild", 0.45]] },
    omarova: { fill: 0.7, segments: [["bos", 1]] },
    nuriyat: { fill: 0.5, segments: [["iv", 0.55], ["lab", 0.3], ["lotos", 0.15]] },
    safiya: { fill: 0.45, segments: [["iv", 0.5], ["lab", 0.5]] },
  };

  /** Окна врача в течение дня: кабинет 2 делят Разият и Омарова. */
  function blocks(plan: StaffPlan, weekday: number, h: { start: number; end: number }): [number, number][] {
    if (plan.key === "omarova") return [[h.start, Math.min(h.end, 13 * 60)]];
    if (plan.key === "raziyat") return weekday >= 5 ? [[h.start, h.end]] : [[13 * 60, h.end]];
    return [[h.start, h.end]];
  }

  interface ApptDraft {
    patient: DemoPatient;
    staff: StaffPlan["key"];
    room: string;
    titles: string[];
    startAt: Date;
    durationMin: number;
  }
  const drafts: ApptDraft[] = [];
  const bosCourseSales: { patient: DemoPatient; at: Date }[] = [];

  function duePatient(segs: Segment[], dayStart: number, dayEnd: number): DemoPatient | null {
    // Сначала те, кому пора по ритму: так повторные идут поверх новых, как в жизни.
    const candidates = patients.filter(
      (p) =>
        segs.includes(p.segment) &&
        p.visits > 0 &&
        p.visits < (p.course ? p.course.stopAt + 1 : p.maxVisits) &&
        p.nextDue <= dayEnd &&
        p.nextDue >= dayStart - 25 * DAY,
    );
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.nextDue - b.nextDue);
    return candidates[0];
  }

  for (let offset = -HISTORY_DAYS; offset <= AHEAD_DAYS; offset++) {
    const midnight = new Date(today.getTime() + offset * DAY);
    const weekday = weekdayOf(midnight);
    const h = hours.get(weekday);
    if (!h) continue;
    // Будущее заполнено тем меньше, чем дальше: так выглядит живая запись.
    const horizon = offset <= 0 ? 1 : offset <= 3 ? 0.85 : offset <= 7 ? 0.6 : offset <= 14 ? 0.35 : 0.18;
    // Клиника росла: девять месяцев назад записей было вдвое меньше.
    const growth = offset >= -60 ? 1 : 0.55 + 0.45 * ((offset + HISTORY_DAYS) / (HISTORY_DAYS - 60));
    for (const plan of STAFF_PLAN) {
      if (!plan.workdays.includes(weekday)) continue;
      const load = LOAD[plan.key];
      const segs = load.segments.map(([s]) => s);
      for (const [from, to] of blocks(plan, weekday, h)) {
        let t = from;
        while (t < to) {
          // Слот определяется первой услугой; длину берём у неё же.
          const take = chance(load.fill * horizon * growth);
          if (!take) {
            t += pick([20, 30, 40]);
            continue;
          }
          const dayStartMs = midnight.getTime();
          const dayEndMs = dayStartMs + DAY;
          let p = duePatient(segs, dayStartMs, dayEndMs);
          // В будущем новые почти не записываются заранее — только постоянные.
          if (!p && (offset <= 0 ? chance(0.45) : offset <= 2 || chance(0.3))) {
            const r = rnd();
            let acc = 0;
            let seg = load.segments[0][0];
            for (const [s, w] of load.segments) {
              acc += w;
              if (r <= acc) {
                seg = s;
                break;
              }
            }
            p = await newPatient(seg, dayStartMs + t * 60_000);
          }
          if (!p) {
            t += 30;
            continue;
          }
          const { titles } = servicesFor(p.segment, p);
          const durationMin = Math.max(...titles.map((x) => svc(x).durationMin));
          if (t + durationMin > to) break;
          const startAt = at(midnight, t);
          drafts.push({ patient: p, staff: plan.key, room: roomId[plan.room], titles, startAt, durationMin });

          p.visits += 1;
          if (p.course) {
            if (p.visits === 2 && !p.course.sold) {
              // Курс покупают в кассе в день первого сеанса.
              p.course.sold = true;
              bosCourseSales.push({ patient: p, at: startAt });
            }
            const gapDays = p.course.perWeek === 3 ? pick([2, 2, 3]) : pick([3, 4]);
            p.nextDue = startAt.getTime() + (p.visits === 1 ? between(2, 6) : gapDays) * DAY;
          } else {
            const gap =
              p.segment === "iv" ? between(6, 10) : p.segment.endsWith("Child") ? between(14, 35) : between(21, 45);
            p.nextDue = startAt.getTime() + gap * DAY;
          }
          t += durationMin + pick([0, 0, 5, 10]);
        }
      }
    }
  }

  // ── запись в базу
  let recordSeq = 930_000_000;
  let pastUnmarked = 0;
  for (const d of drafts) {
    const startMs = d.startAt.getTime();
    const endAt = new Date(startMs + d.durationMin * 60_000);
    const past = endAt.getTime() < now.getTime();
    const startedToday = startMs >= today.getTime() && startMs < today.getTime() + DAY;
    // Запись создают заранее: новых — за 0–5 дней, постоянных — за 1–14.
    const leadDays = d.patient.visits <= 1 ? between(0, 5) : between(1, 14);
    // Запись оформляет администратор — в рабочее время, 08:30–19:00 по часам клиники.
    const bookDay = clinicMidnight(new Date(startMs - leadDays * DAY));
    let createdAt = at(bookDay, between(8 * 60 + 30, 19 * 60));
    if (createdAt.getTime() > startMs - 30 * 60_000) createdAt = new Date(startMs - between(40, 120) * 60_000);
    if (createdAt > now) createdAt = new Date(now.getTime() - between(5, 300) * 60_000);

    let status: "CREATED" | "CONFIRMED" | "ARRIVED" | "NO_SHOW" | "CANCELLED";
    // Сеанс курса не теряют, а переносят: прошедший сеанс в демо состоялся, иначе курс из десяти
    // заканчивался на восьми и весь список «выпавших» состоял бы из пропусков генератора.
    const courseSession = d.patient.segment === "bos" && d.titles[0] !== "Диагностика/консультация на БОС-терапию";
    if (past && courseSession) {
      status = "ARRIVED";
    } else if (past) {
      const r = rnd();
      const recent = now.getTime() - startMs < 9 * DAY;
      if (recent && r < 0.03) {
        status = "CREATED"; // отметку «пришёл» поставят задним числом — разобранность
        pastUnmarked += 1;
      } else if (r < 0.075) status = "CANCELLED";
      else if (r < 0.115) status = "NO_SHOW";
      else status = "ARRIVED";
    } else {
      const r = rnd();
      status = r < 0.05 ? "CANCELLED" : startedToday || startMs - now.getTime() < 2 * DAY ? (r < 0.75 ? "CONFIRMED" : "CREATED") : r < 0.35 ? "CONFIRMED" : "CREATED";
    }

    const lines = d.titles.map((t) => svc(t));
    // Сеанс курса БОС закрывают на абонемент — в записи ноль; продажа — в кассе.
    const isCourseSession = d.patient.segment === "bos" && d.titles[0] !== "Диагностика/консультация на БОС-терапию";
    const charged = lines.map((s) => (isCourseSession ? 0 : s.price));
    const sum = charged.reduce((a, b) => a + b, 0);
    // Сумма в записи остаётся и у отменённой — деньги дня отбирает статус, как у YCLIENTS.
    const revenue = sum;
    const paid = status === "ARRIVED" && revenue > 0;

    const appt = await prisma.appointment.create({
      data: {
        companyId,
        yclientsRecordId: ++recordSeq,
        patientId: d.patient.id,
        staffId: staffId[d.staff],
        roomId: d.room,
        primaryServiceId: lines[0] ? serviceByTitle.get(d.titles[0])!.id : null,
        startAt: d.startAt,
        endAt,
        durationMin: d.durationMin,
        status,
        attendanceRaw: status === "ARRIVED" ? 1 : status === "NO_SHOW" ? -1 : 0,
        revenue,
        // Ноль в записи — сеанс, закрытый на абонемент (`serviceRevenue` выгрузки).
        revenueSource: revenue > 0 ? "RECORD" : "PREPAID",
        paidAmount: paid ? revenue : 0,
        isPaid: paid,
        sourceId: d.patient.visits <= 1 && d.patient.sourceCode ? sourceId[d.patient.sourceCode] : null,
        sourceConfidence: d.patient.sourceCode ? "MANUAL" : "UNKNOWN",
        bookedByStaffUserId: adminIds.length ? pick(adminIds) : null,
        createdAtYclients: createdAt,
        updatedAtYclients: past ? endAt : createdAt,
        cancelledAt: status === "CANCELLED" ? new Date(Math.min(startMs - between(2, 30) * 3600_000, now.getTime())) : null,
        syncState: "SYNCED",
        lastSyncAt: now,
        createdAt,
      },
    });
    for (const [i, t] of d.titles.entries()) {
      await prisma.appointmentService.create({
        data: {
          companyId,
          appointmentId: appt.id,
          serviceId: serviceByTitle.get(t)!.id,
          priceCharged: charged[i],
          durationMin: svc(t).durationMin,
        },
      });
    }
  }
  console.log(`пациентов ${patients.length}, визитов ${drafts.length} (неразобранных в прошлом ${pastUnmarked})`);

  // ── продажи курсов — кассовые операции, как их отдаёт YCLIENTS
  let saleSeq = 77_000_000;
  const transactions: RawTransaction[] = bosCourseSales
    .filter((s) => s.at.getTime() < now.getTime())
    .map((s) => ({
      id: ++saleSeq,
      date: new Date(s.at.getTime() + 50 * 60_000).toISOString(),
      amount: 28_000,
      client: { id: s.patient.yclientsId },
      sold_item_id: saleSeq + 5_000_000,
      sold_item_type: "goods_transaction",
    }));

  // ── пересчёт тем же кодом, что после выгрузки
  const kinds = await recomputeVisitKinds(companyId);
  const rooms = await backfillRooms(companyId);
  const firstSeen = await backfillFirstSeen(companyId);
  const linked = await linkCourses(companyId, transactions, new Date(0));
  const sources = await recomputeAppointmentSources(companyId);
  const patientSources = await recomputePatientSources(companyId, {});
  console.log(
    `визиты: ${kinds.updated} · кабинеты: ${rooms} · первое обращение: ${firstSeen} · ` +
      `курсы: продаж ${transactions.length}, сеансов ${linked.sessions}, без продажи ${linked.orphans} · ` +
      `источники: ${sources.derived}/${patientSources.derived}`,
  );

  // ── заметки к карточкам: то, что администратор пишет руками
  const notes = [
    "Удобно только после 14:00 — работает до обеда.",
    "Ребёнок боится врачей — предупредить Ирину Алилгаджиевну.",
    "Просила напоминать накануне в WhatsApp, звонки не берёт.",
    "Записывает двоих детей, приходят вместе.",
    "Оплачивает переводом, чек отправлять в WhatsApp.",
  ];
  for (const [i, text] of notes.entries()) {
    const p = patients[i * 17 + 3];
    if (p) await prisma.patientNote.create({ data: { companyId, patientId: p.id, kind: "CUSTOM", text, createdById: adminIds[0] ?? null } });
  }

  // ── согласие у тех, кто приходил: подписывают при первом визите
  for (const p of patients.filter((x) => x.visits > 0).slice(0, Math.floor(patients.length * 0.8))) {
    const first = await prisma.appointment.findFirst({
      where: { patientId: p.id, status: "ARRIVED" },
      orderBy: { startAt: "asc" },
      select: { startAt: true },
    });
    if (first) {
      await prisma.patientConsent.create({ data: { companyId, patientId: p.id, documentId: consentDoc.id, grantedAt: first.startAt } });
    }
  }

  await prisma.setting.upsert({
    where: { companyId_key: { companyId, key: "demo" } },
    update: { value: { builtAt: now.toISOString(), users: Object.keys(users) } },
    create: { companyId, key: "demo", value: { builtAt: now.toISOString(), users: Object.keys(users) } },
  });

  console.log(`\nвходы: ${Object.keys(users).join(", ")} (новые — пароль ${DEMO_PASSWORD})`);
  console.log("переписки: AGENT_DRILL=1 npx tsx scripts/demo-dialogs.ts --apply");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
