import { prisma } from "../lib/db";
import type { Prisma } from "../generated/prisma/client";

/**
 * Демонстрационные данные: специалисты, пациенты и визиты за последние 8 недель.
 *
 * Нужны, чтобы на демо-стенде дашборд не был пустым: выручка, приходы клиентов,
 * загрузка кабинетов, динамика по неделям и метрики сотрудников считаются из
 * визитов, а базовый сид создаёт только справочники.
 *
 * Данные согласованы между собой, а не случайны:
 *   - у специалиста свой профиль услуг: остеопат не ставит капельницы;
 *   - визит идёт в кабинет этого направления, а не в произвольный;
 *   - в одном кабинете визиты не накладываются друг на друга — расписание
 *     строится по свободному времени, как в жизни.
 * Без этого «загрузка кабинета» получалась больше 100%, а в карточке остеопата
 * значились процедуры, которых он не делает.
 *
 * Данные вымышленные. Запускать только на демо-контуре: в боевой базе
 * персональные данные заводит клиника (§7).
 *
 * Идемпотентен: свои прошлые строки (префикс demo_) удаляет и создаёт заново.
 *
 *   npm run db:seed:demo
 */

// Детерминированный генератор: один и тот же стенд при каждом прогоне.
let seedState = 20260804;
function rnd(): number {
  seedState = (seedState * 1103515245 + 12345) % 2147483648;
  return seedState / 2147483648;
}
function pick<T>(items: T[]): T {
  return items[Math.floor(rnd() * items.length)];
}

type RoomKey = "proc" | "bos" | "osteo";

/** Кабинет определяется направлением, а услуга — видом. Связь жёсткая. */
const ROOM_BY_PREFIX: Record<RoomKey, string> = {
  proc: "Кабинет 1",
  bos: "Кабинет 2",
  osteo: "Кабинет 3",
};

const SPECIALISTS: {
  key: string;
  name: string;
  specialty: string;
  room: RoomKey;
  /** Виды услуг, которые этот специалист действительно выполняет. */
  kinds: string[];
}[] = [
  { key: "levin", name: "Левин А. И.", specialty: "Остеопат", room: "osteo", kinds: ["OSTEOPATHY"] },
  { key: "sokolova", name: "Соколова Е. В.", specialty: "Остеопат", room: "osteo", kinds: ["OSTEOPATHY"] },
  { key: "moroz", name: "Мороз Д. С.", specialty: "БОС-терапевт", room: "bos", kinds: ["BIOFEEDBACK", "NEUROMEDITATION"] },
  { key: "efimova", name: "Ефимова Н. П.", specialty: "БОС-терапевт", room: "bos", kinds: ["BIOFEEDBACK", "NEUROMEDITATION"] },
  { key: "litvinova", name: "Литвинова О. А.", specialty: "Медсестра процедурного кабинета", room: "proc", kinds: ["IV_THERAPY", "LAB"] },
  { key: "gushina", name: "Гущина Р. К.", specialty: "Медсестра процедурного кабинета", room: "proc", kinds: ["IV_THERAPY", "LAB"] },
];

const PATIENTS = [
  "Гринберг Ирина Львовна", "Чернышёва Жанна Захаровна", "Шаповалова Зоя Ивановна",
  "Эрдман Кристина Леонидовна", "Ковалёв Артём Сергеевич", "Носова Полина Дмитриевна",
  "Асташов Игорь Петрович", "Верещагина Алла Юрьевна", "Дорохов Максим Олегович",
  "Ильина Светлана Марковна", "Кузнецова Дарья Романовна", "Лебедев Никита Андреевич",
  "Мартынова Ольга Павловна", "Панкратов Егор Витальевич", "Ремизова Юлия Тарасовна",
  "Соловьёв Денис Игоревич", "Тарасова Вера Аркадьевна", "Фомин Роман Львович",
];

const WEEKS = 8;
const DAY_START_MIN = 9 * 60;
const DAY_END_MIN = 20 * 60;

async function main() {
  const company = await prisma.company.findFirst({ orderBy: { createdAt: "asc" } });
  if (!company) throw new Error("Компания не найдена — сначала `npm run db:seed`");
  const companyId = company.id;

  const services = await prisma.service.findMany({
    where: { companyId, isActive: true },
    select: { id: true, title: true, kind: true, price: true, durationMin: true },
  });
  if (services.length === 0) throw new Error("Нет услуг — сначала `npm run db:seed`");

  const rooms = await prisma.room.findMany({ where: { companyId }, select: { id: true, name: true } });
  const roomId = (key: RoomKey) => rooms.find((r) => r.name.startsWith(ROOM_BY_PREFIX[key]))?.id ?? null;

  const sources = await prisma.source.findMany({ where: { companyId }, select: { id: true } });

  // Чистим прошлый прогон. Удаляем и старые локальные визиты: они остались от
  // прежнего набора данных, где остеопат «ставил капельницы», и в отчётах
  // такие строки выглядят как ошибка платформы. Визиты, приехавшие из YCLIENTS
  // (у их специалиста есть yclientsStaffId), не трогаем — это не наши данные.
  await prisma.appointment.deleteMany({
    where: { companyId, staff: { yclientsStaffId: null } },
  });
  await prisma.patientPhone.deleteMany({ where: { companyId, id: { startsWith: "demo_ph_" } } });
  await prisma.patient.deleteMany({ where: { companyId, id: { startsWith: "demo_pat_" } } });

  // ── специалисты
  //
  // Существующего специалиста с тем же именем забираем под себя, а не заводим
  // второго: иначе в расписании и в чате появлялись два «Мороз Д. С.» с разными
  // специальностями. Дубликаты по имени убираем мягко.
  const staffIds = new Map<string, string>();
  for (let i = 0; i < SPECIALISTS.length; i++) {
    const s = SPECIALISTS[i];
    const data = {
      name: s.name,
      specialty: s.specialty,
      defaultRoomId: roomId(s.room),
      isActive: true,
      deletedAt: null,
      sortOrder: i + 1,
    };
    const sameName = await prisma.staff.findMany({
      where: { companyId, name: s.name, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });

    let id: string;
    if (sameName.length > 0) {
      id = sameName[0].id;
      await prisma.staff.update({ where: { id }, data });
      for (const dup of sameName.slice(1)) {
        await prisma.staffUser.updateMany({ where: { staffId: dup.id }, data: { staffId: null } });
        await prisma.staff.update({
          where: { id: dup.id },
          data: { deletedAt: new Date(), isActive: false, defaultRoomId: null },
        });
      }
    } else {
      id = `demo_stf_${s.key}`;
      await prisma.staff.upsert({
        where: { id },
        update: data,
        create: { id, companyId, yclientsStaffId: null, ...data },
      });
    }
    staffIds.set(s.key, id);
  }

  // Специалисты вне списка — наследие прежних наборов. Прячем, чтобы в
  // расписании и в выборе врача не оставалось лишних имён.
  const keepIds = [...staffIds.values()];
  await prisma.staffUser.updateMany({
    where: { companyId, staffId: { notIn: keepIds }, staff: { yclientsStaffId: null } },
    data: { staffId: null },
  });
  const hidden = await prisma.staff.updateMany({
    where: { companyId, deletedAt: null, yclientsStaffId: null, id: { notIn: keepIds } },
    data: { deletedAt: new Date(), isActive: false, defaultRoomId: null },
  });
  if (hidden.count > 0) console.log(`скрыто лишних специалистов: ${hidden.count}`);

  // ── пациенты
  const patientIds: string[] = [];
  for (let i = 0; i < PATIENTS.length; i++) {
    const id = `demo_pat_${i + 1}`;
    const phone = `+79${String(160000000 + i * 111111).slice(0, 9)}`;
    await prisma.patient.create({
      data: {
        id,
        companyId,
        name: PATIENTS[i],
        firstSeenAt: new Date(Date.now() - (WEEKS + 4) * 7 * 24 * 3600 * 1000),
        sourceId: sources.length ? pick(sources).id : null,
      },
    });
    await prisma.patientPhone.create({
      data: { id: `demo_ph_${i + 1}`, companyId, patientId: id, phone, isPrimary: true },
    });
    patientIds.push(id);
  }

  // ── визиты: по каждому кабинету идём по времени, не допуская наложений
  const firstArrivedSeen = new Set<string>();
  const rows: Prisma.AppointmentCreateManyInput[] = [];
  let index = 0;

  for (let dayBack = WEEKS * 7; dayBack >= 0; dayBack--) {
    const day = new Date();
    day.setDate(day.getDate() - dayBack);
    day.setHours(0, 0, 0, 0);
    if (day.getDay() === 0) continue; // воскресенье клиника не работает

    for (const key of Object.keys(ROOM_BY_PREFIX) as RoomKey[]) {
      const roomSpecialists = SPECIALISTS.filter((s) => s.room === key);
      const roomServices = services.filter((s) => roomSpecialists.some((sp) => sp.kinds.includes(s.kind)));
      if (roomServices.length === 0) continue;

      // Курсор времени по кабинету: следующий визит начинается не раньше, чем
      // закончился предыдущий. Так наложений нет по построению.
      let cursor = DAY_START_MIN;
      while (cursor < DAY_END_MIN) {
        // Пауза между визитами. Кабинет не забит подряд: клиника грузится
        // примерно на две трети, иначе метрика загрузки упирается в 100%
        // и перестаёт что-либо показывать.
        cursor += rnd() < 0.55 ? 20 + Math.floor(rnd() * 70) : 10;
        const service = pick(roomServices);
        const duration = service.durationMin ?? 60;
        if (cursor + duration > DAY_END_MIN) break;

        const specialist = pick(roomSpecialists.filter((sp) => sp.kinds.includes(service.kind)));
        const staffId = staffIds.get(specialist.key)!;
        const patientId = pick(patientIds);

        const start = new Date(day);
        start.setMinutes(cursor);

        const past = dayBack > 0;
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

        rows.push({
          id: `demo_appt_${index}`,
          companyId,
          yclientsRecordId: 900000 + index,
          patientId,
          staffId,
          roomId: roomId(key),
          primaryServiceId: service.id,
          sourceId: sources.length ? pick(sources).id : null,
          startAt: start,
          endAt: new Date(start.getTime() + duration * 60_000),
          createdAtYclients: new Date(start.getTime() - 24 * 3600 * 1000),
          updatedAtYclients: new Date(start.getTime() - 24 * 3600 * 1000),
          durationMin: duration,
          status,
          isFirstVisit: firstVisit,
          revenue: arrived ? (service.price ?? 0) : 0,
          paidAmount: arrived ? (service.price ?? 0) : 0,
          isPaid: arrived,
        });
        index += 1;
        cursor += duration;
      }
    }
  }

  await prisma.appointment.createMany({ data: rows });

  const arrivedCount = await prisma.appointment.count({ where: { companyId, status: "ARRIVED" } });
  const revenue = await prisma.appointment.aggregate({
    where: { companyId, status: "ARRIVED" },
    _sum: { revenue: true },
  });
  console.log(
    `демо-данные: специалистов=${SPECIALISTS.length}, пациентов=${PATIENTS.length}, ` +
      `визитов=${rows.length} (пришли ${arrivedCount}), выручка=${Number(revenue._sum.revenue ?? 0)} ₽`,
  );
  await prisma.$disconnect();
}

void main();
