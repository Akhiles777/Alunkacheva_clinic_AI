/**
 * Идемпотентный сид справочников.
 *
 * Сюда попадает только то, что не приходит из YCLIENTS: источники обращений,
 * кабинеты и их рабочие часы. Пациенты, записи и деньги приезжают начальной
 * выгрузкой, руками их сюда класть нельзя.
 */
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { SourceKind, ServiceKind } from "../generated/prisma/enums";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const SOURCES: { code: string; title: string; kind: SourceKind; sortOrder: number }[] = [
  { code: "instagram", title: "Instagram", kind: "MESSENGER", sortOrder: 10 },
  { code: "whatsapp", title: "WhatsApp", kind: "MESSENGER", sortOrder: 20 },
  { code: "phone", title: "Звонок", kind: "PHONE", sortOrder: 30 },
  { code: "site", title: "Сайт", kind: "WEB", sortOrder: 40 },
  { code: "offline", title: "Пришёл сам", kind: "OFFLINE", sortOrder: 50 },
  { code: "referral", title: "Рекомендация", kind: "REFERRAL", sortOrder: 60 },
];

const ROOMS = [
  { name: "Кабинет 1 — остеопатия", sortOrder: 1 },
  { name: "Кабинет 2 — IV-терапия", sortOrder: 2 },
  { name: "Кабинет 3 — БОС и нейромедитация", sortOrder: 3 },
];

/** Прайс-заглушка: реальные услуги перезапишет синхронизация с YCLIENTS. */
const SERVICES: {
  yclientsServiceId: number;
  title: string;
  kind: ServiceKind;
  price: string;
  durationMin: number;
  isCourse: boolean;
  defaultSessions: number | null;
}[] = [
  { yclientsServiceId: 1001, title: "Остеопатия, приём", kind: "OSTEOPATHY", price: "7000.00", durationMin: 60, isCourse: false, defaultSessions: null },
  { yclientsServiceId: 1002, title: "Остеопатия, коррекция", kind: "OSTEOPATHY", price: "6000.00", durationMin: 45, isCourse: false, defaultSessions: null },
  { yclientsServiceId: 2001, title: "IV-терапия, капельница", kind: "IV_THERAPY", price: "6500.00", durationMin: 90, isCourse: true, defaultSessions: 10 },
  { yclientsServiceId: 2002, title: "IV-терапия, экспресс", kind: "IV_THERAPY", price: "4500.00", durationMin: 60, isCourse: true, defaultSessions: 8 },
  { yclientsServiceId: 3001, title: "БОС-терапия, сеанс", kind: "BIOFEEDBACK", price: "5000.00", durationMin: 40, isCourse: true, defaultSessions: 12 },
  { yclientsServiceId: 4001, title: "Нейромедитация", kind: "NEUROMEDITATION", price: "6000.00", durationMin: 30, isCourse: false, defaultSessions: null },
  { yclientsServiceId: 5001, title: "Забор анализов", kind: "LAB", price: "1500.00", durationMin: 15, isCourse: false, defaultSessions: null },
  { yclientsServiceId: 5002, title: "Забор крови из пальца", kind: "LAB", price: "900.00", durationMin: 10, isCourse: false, defaultSessions: null },
];

async function main() {
  const yclientsId = Number(process.env.CLINIC_YCLIENTS_COMPANY_ID ?? 0);

  const company = await prisma.company.upsert({
    where: { yclientsId },
    update: {},
    create: {
      yclientsId,
      name: process.env.CLINIC_NAME ?? "Клиника интегративной медицины",
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

  for (const service of SERVICES) {
    await prisma.service.upsert({
      where: {
        companyId_yclientsServiceId: {
          companyId: company.id,
          yclientsServiceId: service.yclientsServiceId,
        },
      },
      update: { title: service.title, price: service.price, durationMin: service.durationMin },
      create: { ...service, companyId: company.id },
    });
  }

  // Кабинеты и рабочие часы 09:00–21:00 пн–сб, воскресенье выходной.
  // Это знаменатель метрики загрузки — заводим явно, а не догадками.
  const validFrom = new Date("2020-01-01T00:00:00.000Z");
  for (const [index, room] of ROOMS.entries()) {
    const yclientsResourceId = 900 + index;
    const created = await prisma.room.upsert({
      where: { companyId_yclientsResourceId: { companyId: company.id, yclientsResourceId } },
      update: { name: room.name, sortOrder: room.sortOrder },
      create: { ...room, yclientsResourceId, companyId: company.id },
    });

    for (let weekday = 1; weekday <= 6; weekday++) {
      await prisma.roomSchedule.upsert({
        where: { roomId_weekday_validFrom: { roomId: created.id, weekday, validFrom } },
        update: { startMinute: 9 * 60, endMinute: 21 * 60 },
        create: {
          companyId: company.id,
          roomId: created.id,
          weekday,
          startMinute: 9 * 60,
          endMinute: 21 * 60,
          validFrom,
        },
      });
    }
  }

  const sources = await prisma.source.count({ where: { companyId: company.id } });
  console.log(`seed ok: company=${company.name}, sources=${sources}, rooms=${ROOMS.length}, services=${SERVICES.length}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
