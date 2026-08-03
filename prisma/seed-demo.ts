import { prisma } from "../lib/db";

/**
 * Демонстрационные данные: специалисты, пациенты и визиты за последние 8 недель.
 *
 * Нужны, чтобы на демо-стенде дашборд не был пустым: выручка, приходы клиентов,
 * загрузка кабинетов, динамика по неделям и метрики сотрудников считаются из
 * визитов, а базовый сид создаёт только справочники.
 *
 * Данные вымышленные. Запускать только на демо-контуре: в боевой базе
 * персональные данные заводит клиника (§7).
 *
 * Идемпотентен: повторный запуск не задваивает — визиты и пациенты имеют
 * стабильные идентификаторы.
 *
 *   npm run db:seed:demo
 */

// Детерминированный генератор: один и тот же стенд при каждом прогоне.
let seedState = 20260803;
function rnd(): number {
  seedState = (seedState * 1103515245 + 12345) % 2147483648;
  return seedState / 2147483648;
}
function pick<T>(items: T[]): T {
  return items[Math.floor(rnd() * items.length)];
}

const SPECIALISTS = [
  { key: "levin", name: "Левин А. И.", specialty: "Остеопат", room: "Кабинет 3" },
  { key: "sokolova", name: "Соколова Е. В.", specialty: "Остеопат", room: "Кабинет 3" },
  { key: "moroz", name: "Мороз Д. С.", specialty: "Специалист по БОС", room: "Кабинет 2" },
  { key: "efimova", name: "Ефимова Н. П.", specialty: "БОС-терапевт", room: "Кабинет 2" },
  { key: "litvinova", name: "Литвинова О. А.", specialty: "Медсестра", room: "Кабинет 1" },
  { key: "gushina", name: "Гущина Р. К.", specialty: "Медсестра", room: "Кабинет 1" },
];

const PATIENTS = [
  "Гринберг Ирина Львовна", "Чернышёва Жанна Захаровна", "Шаповалова Зоя Ивановна",
  "Эрдман Кристина Леонидовна", "Ковалёв Артём Сергеевич", "Носова Полина Дмитриевна",
  "Асташов Игорь Петрович", "Верещагина Алла Юрьевна", "Дорохов Максим Олегович",
  "Ильина Светлана Марковна", "Кузнецова Дарья Романовна", "Лебедев Никита Андреевич",
  "Мартынова Ольга Павловна", "Панкратов Егор Витальевич", "Ремизова Юлия Тарасовна",
  "Соловьёв Денис Игоревич",
];

const WEEKS = 8;
const APPTS_PER_WEEK = 22;

async function main() {
  const company = await prisma.company.findFirst({ orderBy: { createdAt: "asc" } });
  if (!company) throw new Error("Компания не найдена — сначала `npm run db:seed`");
  const companyId = company.id;

  const services = await prisma.service.findMany({
    where: { companyId, isActive: true },
    select: { id: true, title: true, price: true, durationMin: true },
  });
  if (services.length === 0) throw new Error("Нет услуг — сначала `npm run db:seed`");

  const rooms = await prisma.room.findMany({ where: { companyId }, select: { id: true, name: true } });
  const roomByPrefix = (prefix: string) => rooms.find((r) => r.name.startsWith(prefix))?.id ?? null;

  const sources = await prisma.source.findMany({ where: { companyId }, select: { id: true } });

  // ── специалисты
  const staffIds = new Map<string, string>();
  for (let i = 0; i < SPECIALISTS.length; i++) {
    const s = SPECIALISTS[i];
    const id = `demo_stf_${s.key}`;
    await prisma.staff.upsert({
      where: { id },
      update: { name: s.name, specialty: s.specialty, isActive: true, deletedAt: null },
      create: {
        id,
        companyId,
        yclientsStaffId: null,
        name: s.name,
        specialty: s.specialty,
        defaultRoomId: roomByPrefix(s.room),
        isActive: true,
        sortOrder: i + 1,
      },
    });
    staffIds.set(s.key, id);
  }

  // ── пациенты
  const patientIds: string[] = [];
  for (let i = 0; i < PATIENTS.length; i++) {
    const id = `demo_pat_${i + 1}`;
    const phone = `+7916${String(1000000 + i * 4321).slice(0, 7)}`;
    await prisma.patient.upsert({
      where: { id },
      update: { name: PATIENTS[i] },
      create: {
        id,
        companyId,
        name: PATIENTS[i],
        firstSeenAt: new Date(Date.now() - (WEEKS + 4) * 7 * 24 * 3600 * 1000),
        sourceId: sources.length ? pick(sources).id : null,
      },
    });
    await prisma.patientPhone.upsert({
      where: { id: `demo_ph_${i + 1}` },
      update: {},
      create: { id: `demo_ph_${i + 1}`, companyId, patientId: id, phone, isPrimary: true },
    });
    patientIds.push(id);
  }

  // ── визиты за последние 8 недель
  const firstArrivedSeen = new Set<string>();
  const staffKeys = [...staffIds.keys()];
  let created = 0;

  for (let week = WEEKS; week >= 0; week--) {
    for (let n = 0; n < APPTS_PER_WEEK; n++) {
      const index = week * APPTS_PER_WEEK + n;
      const id = `demo_appt_${index}`;

      // День недели пн–сб, время 9:00–19:00 с шагом 30 минут.
      const daysBack = week * 7 + Math.floor(rnd() * 6);
      const start = new Date();
      start.setDate(start.getDate() - daysBack);
      start.setHours(9 + Math.floor(rnd() * 10), rnd() < 0.5 ? 0 : 30, 0, 0);

      const service = pick(services);
      const staffKey = pick(staffKeys);
      const staffId = staffIds.get(staffKey)!;
      const specialist = SPECIALISTS.find((s) => s.key === staffKey)!;
      const patientId = pick(patientIds);
      const duration = service.durationMin ?? 60;

      // Прошедшие визиты имеют исход, сегодняшние и будущие — ещё нет.
      const past = daysBack > 0;
      const roll = rnd();
      const status = !past
        ? roll < 0.5
          ? "CONFIRMED"
          : "CREATED"
        : roll < 0.78
          ? "ARRIVED"
          : roll < 0.87
            ? "NO_SHOW"
            : roll < 0.94
              ? "CANCELLED"
              : "CONFIRMED";

      const arrived = status === "ARRIVED";
      const firstVisit = arrived && !firstArrivedSeen.has(patientId);
      if (firstVisit) firstArrivedSeen.add(patientId);

      await prisma.appointment.upsert({
        where: { id },
        update: {},
        create: {
          id,
          companyId,
          yclientsRecordId: 900000 + index,
          patientId,
          staffId,
          roomId: roomByPrefix(specialist.room),
          primaryServiceId: service.id,
          sourceId: sources.length ? pick(sources).id : null,
          startAt: start,
          endAt: new Date(start.getTime() + duration * 60_000),
          // Проекция YCLIENTS: у записи всегда есть время создания на их стороне.
          createdAtYclients: new Date(start.getTime() - 24 * 3600 * 1000),
          updatedAtYclients: new Date(start.getTime() - 24 * 3600 * 1000),
          durationMin: duration,
          status,
          isFirstVisit: firstVisit,
          revenue: arrived ? service.price ?? 0 : 0,
          paidAmount: arrived ? service.price ?? 0 : 0,
          isPaid: arrived,
        },
      });
      created++;
    }
  }

  const arrivedCount = await prisma.appointment.count({ where: { companyId, status: "ARRIVED" } });
  const revenue = await prisma.appointment.aggregate({
    where: { companyId, status: "ARRIVED" },
    _sum: { revenue: true },
  });
  console.log(
    `демо-данные: специалистов=${SPECIALISTS.length}, пациентов=${PATIENTS.length}, ` +
      `визитов=${created} (пришли ${arrivedCount}), выручка=${Number(revenue._sum.revenue ?? 0)} ₽`,
  );
  await prisma.$disconnect();
}

void main();
