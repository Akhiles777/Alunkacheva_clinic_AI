/**
 * Идемпотентный сид справочников.
 *
 * Сюда попадает только то, что не приходит из YCLIENTS: источники обращений,
 * кабинеты и их часы, привязка услуг к кабинетам, матрица прав, дефолтные
 * настройки и текст согласия. Пациенты, записи, деньги и специалисты приезжают
 * начальной выгрузкой (волна 5), руками их сюда класть нельзя.
 */
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { SourceKind, ServiceKind, StaffRole, Permission } from "../generated/prisma/enums";
import { CLINIC_NAME } from "../lib/brand";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const SOURCES: { code: string; title: string; kind: SourceKind; sortOrder: number }[] = [
  { code: "instagram", title: "Instagram", kind: "MESSENGER", sortOrder: 10 },
  { code: "whatsapp", title: "WhatsApp", kind: "MESSENGER", sortOrder: 20 },
  { code: "telegram", title: "Telegram", kind: "MESSENGER", sortOrder: 25 },
  { code: "phone", title: "Звонок", kind: "PHONE", sortOrder: 30 },
  { code: "site", title: "Сайт", kind: "WEB", sortOrder: 40 },
  { code: "offline", title: "Пришёл сам", kind: "OFFLINE", sortOrder: 50 },
  { code: "referral", title: "Рекомендация", kind: "REFERRAL", sortOrder: 60 },
];

// Три кабинета по фактам §2. key используется для привязки услуг.
const ROOMS: { key: "proc" | "bos" | "osteo"; name: string; direction: string; sortOrder: number }[] = [
  { key: "proc", name: "Кабинет 1 — процедурный", direction: "IV-терапия", sortOrder: 1 },
  { key: "bos", name: "Кабинет 2 — БОС-терапии", direction: "БОС-терапия", sortOrder: 2 },
  { key: "osteo", name: "Кабинет 3 — остеопата", direction: "Остеопатия", sortOrder: 3 },
];

/** Прайс-заглушка: реальные услуги перезапишет синхронизация с YCLIENTS.
 *  rooms — где услуга может проводиться; stalled — порог выпадения из графика. */
const SERVICES: {
  yclientsServiceId: number;
  title: string;
  kind: ServiceKind;
  price: string;
  durationMin: number;
  isCourse: boolean;
  defaultSessions: number | null;
  stalledAfterDays: number | null;
  rooms: ("proc" | "bos" | "osteo")[];
}[] = [
  { yclientsServiceId: 1001, title: "Остеопатия, приём", kind: "OSTEOPATHY", price: "7000.00", durationMin: 60, isCourse: false, defaultSessions: null, stalledAfterDays: null, rooms: ["osteo"] },
  { yclientsServiceId: 1002, title: "Остеопатия, коррекция", kind: "OSTEOPATHY", price: "6000.00", durationMin: 45, isCourse: false, defaultSessions: null, stalledAfterDays: null, rooms: ["osteo"] },
  { yclientsServiceId: 2001, title: "IV-терапия, капельница", kind: "IV_THERAPY", price: "6500.00", durationMin: 90, isCourse: true, defaultSessions: 10, stalledAfterDays: 10, rooms: ["proc", "bos"] },
  { yclientsServiceId: 2002, title: "IV-терапия, экспресс", kind: "IV_THERAPY", price: "4500.00", durationMin: 60, isCourse: true, defaultSessions: 8, stalledAfterDays: 10, rooms: ["proc", "bos"] },
  { yclientsServiceId: 3001, title: "БОС-терапия, сеанс", kind: "BIOFEEDBACK", price: "5000.00", durationMin: 40, isCourse: true, defaultSessions: 12, stalledAfterDays: 14, rooms: ["bos"] },
  { yclientsServiceId: 4001, title: "Нейромедитация", kind: "NEUROMEDITATION", price: "6000.00", durationMin: 30, isCourse: false, defaultSessions: null, stalledAfterDays: null, rooms: ["bos"] },
  { yclientsServiceId: 5001, title: "Забор анализов", kind: "LAB", price: "1500.00", durationMin: 15, isCourse: false, defaultSessions: null, stalledAfterDays: null, rooms: ["proc"] },
  { yclientsServiceId: 5002, title: "Забор крови из пальца", kind: "LAB", price: "900.00", durationMin: 10, isCourse: false, defaultSessions: null, stalledAfterDays: null, rooms: ["proc"] },
];

// Матрица прав по умолчанию (§4.4). Редактируется в настройках.
const PERMISSIONS: Permission[] = [
  "VIEW_OTHER_PATIENTS",
  "VIEW_REVENUE",
  "EDIT_SETTINGS",
  "MESSAGE_PATIENTS",
  "VIEW_AUDIT",
];
const ROLE_MATRIX: Record<StaffRole, Permission[]> = {
  OWNER: ["VIEW_OTHER_PATIENTS", "VIEW_REVENUE", "EDIT_SETTINGS", "MESSAGE_PATIENTS", "VIEW_AUDIT"],
  MANAGER: ["VIEW_OTHER_PATIENTS", "VIEW_REVENUE", "MESSAGE_PATIENTS", "VIEW_AUDIT"],
  // Администратор ведёт клинику ежедневно: заводит сотрудников, услуги и цены.
  // Без EDIT_SETTINGS пункт «Настройки» превращался в кнопку, которая падает.
  ADMIN: ["VIEW_OTHER_PATIENTS", "MESSAGE_PATIENTS", "EDIT_SETTINGS"],
  DOCTOR: [],
};

/** Стартовая база знаний ассистента. Клиника правит её в «Настройки → Ассистент». */
const KNOWLEDGE: { topic: string; question: string; answer: string }[] = [
  { topic: "Часы работы", question: "Когда вы работаете?", answer: "Пн–Сб с 09:00 до 21:00, воскресенье — выходной." },
  { topic: "Как записаться", question: "Как записаться на приём?", answer: "Запись ведёт администратор: напишите здесь, и он подберёт удобное время." },
  { topic: "Отмена записи", question: "Как отменить или перенести запись?", answer: "Сообщите об этом заранее, лучше не позже чем за сутки — администратор перенесёт визит." },
  { topic: "Оплата", question: "Как можно оплатить?", answer: "Оплата в клинике после приёма: наличными или картой." },
  { topic: "Согласие на обработку данных", question: "Зачем подписывать согласие?", answer: "Согласие на обработку персональных данных нужно по закону — без него мы не можем вести карту пациента. Подписывается один раз при первом визите." },
  { topic: "Подготовка к капельнице", question: "Как готовиться к IV-терапии?", answer: "Лёгкий приём пищи за 1–2 часа до процедуры и обычный питьевой режим. Если принимаете лекарства — предупредите специалиста." },
  { topic: "Подготовка к остеопатии", question: "Как готовиться к приёму остеопата?", answer: "Приходите в удобной одежде, не есть плотно за час до приёма. Возьмите с собой снимки и заключения, если они есть." },
  { topic: "Первый визит", question: "Что взять на первый приём?", answer: "Паспорт для оформления карты и медицинские документы, если они у вас есть." },
];

const SETTINGS: { key: string; value: unknown }[] = [
  // Источник кабинета для загрузки. Дублирует прежний флаг ROOMS_FROM_RESOURCES.
  { key: "rooms.sourceMode", value: "staff-mapping" },
  // Ассистент по умолчанию только черновики (§6.4).
  { key: "assistant.mode", value: "drafts" },
  // Отчётные сутки заканчиваются в полночь (§2).
  { key: "report.dayBoundaryMinute", value: 0 },
  // Уведомления: воскресенье копим до понедельника (§4.9).
  { key: "notifications.batchWeekdays", value: [7] },
];

async function main() {
  const yclientsId = Number(process.env.CLINIC_YCLIENTS_COMPANY_ID ?? 0);

  const company = await prisma.company.upsert({
    where: { yclientsId },
    update: {},
    create: {
      yclientsId,
      name: process.env.CLINIC_NAME ?? CLINIC_NAME,
      timezone: process.env.CLINIC_TIMEZONE ?? "Europe/Moscow",
    },
  });

  for (const source of SOURCES) {
    await prisma.source.upsert({
      where: { companyId_code: { companyId: company.id, code: source.code } },
      update: { title: source.title, kind: source.kind, sortOrder: source.sortOrder },
      create: { ...source, companyId: company.id },
    });
  }

  const serviceIdByYclients = new Map<number, string>();
  for (const service of SERVICES) {
    const data = {
      yclientsServiceId: service.yclientsServiceId,
      title: service.title,
      kind: service.kind,
      price: service.price,
      durationMin: service.durationMin,
      isCourse: service.isCourse,
      defaultSessions: service.defaultSessions,
      stalledAfterDays: service.stalledAfterDays,
    };
    const created = await prisma.service.upsert({
      where: {
        companyId_yclientsServiceId: { companyId: company.id, yclientsServiceId: service.yclientsServiceId },
      },
      update: {
        title: data.title,
        price: data.price,
        durationMin: data.durationMin,
        isCourse: data.isCourse,
        defaultSessions: data.defaultSessions,
        stalledAfterDays: data.stalledAfterDays,
      },
      create: { ...data, companyId: company.id },
    });
    serviceIdByYclients.set(service.yclientsServiceId, created.id);
  }

  // Общие часы работы клиники 09:00–21:00 пн–сб (§4.1). Кабинеты наследуют.
  const validFrom = new Date("2020-01-01T00:00:00.000Z");
  for (let weekday = 1; weekday <= 6; weekday++) {
    await prisma.clinicSchedule.upsert({
      where: { companyId_weekday_validFrom: { companyId: company.id, weekday, validFrom } },
      update: { startMinute: 9 * 60, endMinute: 21 * 60 },
      create: { companyId: company.id, weekday, startMinute: 9 * 60, endMinute: 21 * 60, validFrom },
    });
  }

  // Кабинеты + их часы (совпадают с клиникой) + привязка услуг.
  const roomIdByKey = new Map<string, string>();
  for (const [index, room] of ROOMS.entries()) {
    const yclientsResourceId = 900 + index;
    const created = await prisma.room.upsert({
      where: { companyId_yclientsResourceId: { companyId: company.id, yclientsResourceId } },
      update: { name: room.name, direction: room.direction, sortOrder: room.sortOrder },
      create: {
        name: room.name,
        direction: room.direction,
        sortOrder: room.sortOrder,
        yclientsResourceId,
        companyId: company.id,
      },
    });
    roomIdByKey.set(room.key, created.id);

    for (let weekday = 1; weekday <= 6; weekday++) {
      await prisma.roomSchedule.upsert({
        where: { roomId_weekday_validFrom: { roomId: created.id, weekday, validFrom } },
        update: { startMinute: 9 * 60, endMinute: 21 * 60 },
        create: { companyId: company.id, roomId: created.id, weekday, startMinute: 9 * 60, endMinute: 21 * 60, validFrom },
      });
    }
  }

  // Где услуга может проводиться — знаменатель загрузки по услугам.
  for (const service of SERVICES) {
    const serviceId = serviceIdByYclients.get(service.yclientsServiceId)!;
    for (const roomKey of service.rooms) {
      const roomId = roomIdByKey.get(roomKey)!;
      await prisma.serviceRoom.upsert({
        where: { serviceId_roomId: { serviceId, roomId } },
        update: {},
        create: { companyId: company.id, serviceId, roomId },
      });
    }
  }

  // Матрица прав по ролям.
  for (const role of Object.keys(ROLE_MATRIX) as StaffRole[]) {
    const allowedSet = new Set(ROLE_MATRIX[role]);
    for (const permission of PERMISSIONS) {
      await prisma.rolePermission.upsert({
        where: { companyId_role_permission: { companyId: company.id, role, permission } },
        update: { allowed: allowedSet.has(permission) },
        create: { companyId: company.id, role, permission, allowed: allowedSet.has(permission) },
      });
    }
  }

  // База знаний ассистента: без неё бот на любой вопрос зовёт человека.
  for (const k of KNOWLEDGE) {
    const existing = await prisma.knowledgeEntry.findFirst({
      where: { companyId: company.id, topic: k.topic },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.knowledgeEntry.create({
      data: { companyId: company.id, topic: k.topic, question: k.question, answer: k.answer, isActive: true },
    });
  }

  // Дефолтные настройки.
  for (const setting of SETTINGS) {
    await prisma.setting.upsert({
      where: { companyId_key: { companyId: company.id, key: setting.key } },
      update: { value: setting.value as object },
      create: { companyId: company.id, key: setting.key, value: setting.value as object },
    });
  }

  // Текст согласия на обработку ПДн, версия 1.0.
  await prisma.consentDocument.upsert({
    where: { companyId_version: { companyId: company.id, version: "1.0" } },
    update: {},
    create: {
      companyId: company.id,
      version: "1.0",
      text: "Согласие на обработку персональных данных. Текст заполняется клиникой в настройках.",
      isActive: true,
    },
  });

  console.log(
    `seed ok: sources=${SOURCES.length}, rooms=${ROOMS.length}, services=${SERVICES.length}, ` +
      `serviceRooms=${SERVICES.reduce((n, s) => n + s.rooms.length, 0)}, roles=${Object.keys(ROLE_MATRIX).length}`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
