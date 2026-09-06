/**
 * Песочница для прогонов ассистента.
 *
 * Проверять агента на настоящих правилах можно только с базой: справочник,
 * услуги, специалисты, настройки ассистента, согласие и записи пациента —
 * всё это агент читает из неё, и без базы проверяется не агент, а модель.
 * Боевые данные для этого не годятся: прогон пишет сообщения и эскалации, а
 * они попадают в метрики и будят администраторов.
 *
 * Поэтому — местная клиника, похожая на настоящую: те же услуги, те же имена
 * врачей, тот же стоп-лист (включая «окошко» — из-за него разговор с
 * пациенткой оборвался на просьбе записать племянника), та же инструкция из
 * «Настройки → Ассистент».
 *
 * Разворачивается ТОЛЬКО там, где нет работающей клиники.
 *
 * Первая версия проверяла, что база на localhost, — и это была ошибка: на
 * сервере боевой Postgres тоже localhost, песочница развернулась прямо в
 * рабочей базе, и её выдуманная клиника попала в круг выгрузки. Правильная
 * проверка не про адрес базы, а про её содержимое: есть ли здесь настоящая
 * клиника. Убрать последствия — scripts/agent-sandbox-drop.ts.
 *
 *   npx tsx scripts/agent-sandbox-seed.ts
 */
import "dotenv/config";
import { prisma } from "../lib/db";

import { SANDBOX_YCLIENTS_ID } from "./sandbox-id";

/**
 * Есть ли в этой базе работающая клиника.
 *
 * Проверяем по содержимому, а не по адресу базы: адрес на боевом сервере
 * ничем не отличается от локального. Настоящая клиника — та, у которой есть
 * номер филиала YCLIENTS и хоть один визит.
 */
async function assertNoLiveClinic() {
  const live = await prisma.company.findFirst({
    where: { yclientsId: { gte: 100 } },
    select: { id: true, name: true, yclientsId: true },
  });
  if (!live) return;

  const visits = await prisma.appointment.count({ where: { companyId: live.id } });
  if (visits === 0 && process.env.SANDBOX_FORCE !== "1") {
    console.error(`В базе есть клиника «${live.name}» (филиал ${live.yclientsId}), но без визитов.`);
    console.error("Если это всё же тестовая копия — SANDBOX_FORCE=1 npx tsx scripts/agent-sandbox-seed.ts");
    process.exit(1);
  }
  if (visits > 0) {
    console.error(`ЭТО БОЕВАЯ БАЗА: клиника «${live.name}», визитов ${visits}.`);
    console.error("Песочницу здесь не разворачиваем — она создаёт выдуманных пациентов и записи.");
    console.error("Прогон ассистента идёт на местной базе разработчика.");
    console.error("Если песочница уже сюда попала: npx tsx scripts/agent-sandbox-drop.ts --apply");
    process.exit(1);
  }
}

/** Услуги — с настоящими названиями клиники: на них проверяются цены и дубли. */
const SERVICES = [
  { title: "Взрослый прием - остеопатия", price: 8000, durationMin: 45, yclientsServiceId: 1 },
  { title: "Детский прием до 10 л - остеопатия", price: 5000, durationMin: 40, yclientsServiceId: 2 },
  { title: "БОС-терапия, сеанс", price: 2800, durationMin: 40, yclientsServiceId: 3, isCourse: true, defaultSessions: 10 },
  { title: "Консультация", price: 3000, durationMin: 30, yclientsServiceId: 4 },
  { title: "Внутривенное капельное введение растворов", price: 2500, durationMin: 60, yclientsServiceId: 5 },
];

const STAFF = [
  { name: "Ирина Алилгаджиевна", specialty: "Остеопат", yclientsStaffId: 1 },
  { name: "Разият Ризвановна", specialty: "Невролог", yclientsStaffId: 2 },
];

/**
 * Справочник. Намеренно неполный: про парковку и про беременность записей нет —
 * на них проверяется, что агент не выдумывает, а зовёт человека.
 */
const KNOWLEDGE = [
  {
    topic: "Адрес",
    question: "Где вы находитесь? Как вас найти? Адрес клиники",
    answer:
      "Мы находимся в Махачкале, улица Ленина, 1, второй этаж. Вход со стороны двора, есть указатели.",
  },
  {
    topic: "Часы работы",
    question: "Во сколько вы работаете? График работы, часы приёма",
    answer: "Работаем с понедельника по субботу с 09:00 до 21:00. Воскресенье — выходной.",
  },
  {
    topic: "Подготовка к приёму",
    question: "Как подготовиться к приёму остеопата? Что взять с собой?",
    answer:
      "Приходите в удобной одежде, которая не стесняет движений. Плотно есть за час до приёма не стоит. " +
      "Если есть свежие снимки или заключения — возьмите их с собой.",
  },
  {
    topic: "Отмена записи",
    question: "Условия отмены записи, если не смогу прийти",
    answer:
      "Если планы изменились, предупредите нас не позже чем за 3 часа до приёма — тогда мы успеем " +
      "предложить время другому пациенту.",
  },
  {
    topic: "Оплата",
    question: "Как можно оплатить? Картой, наличными",
    answer: "Оплатить можно картой или наличными на стойке администратора.",
  },
  {
    topic: "Специалисты",
    question: "Кто принимает? Какие врачи работают",
    answer:
      "Принимают: Ирина Алилгаджиевна — остеопат, взрослый и детский приём; " +
      "Разият Ризвановна — невролог.",
  },
  {
    topic: "Детский приём",
    question: "С какого возраста принимаете детей? Детский приём",
    answer:
      "Детский приём — до 10 лет, ведёт Ирина Алилгаджиевна. Приходите вместе с ребёнком, " +
      "родитель присутствует на приёме.",
  },
];

/** Инструкция клиники из «Настройки → Ассистент» — та, что завёл заказчик. */
const CLINIC_PROMPT = [
  "Когда человек хочет записаться, доведи диалог до передачи подготовленной заявки администратору.",
  "1. Определи услугу. Если это остеопатия — уточни, для взрослого или ребёнка.",
  "2. Кратко назови цену и длительность из базы знаний.",
  "3. Запроси данные ОДНИМ сообщением: ФИО, возраст, кратко причину обращения.",
  "4. Данные не анализируй и не оценивай — подтверди, что передал администратору.",
  "Не задавай больше одного уточняющего вопроса за раз.",
  "Не спрашивай то, что пациент уже сообщил.",
].join("\n");

async function main() {
  await assertNoLiveClinic();

  const company = await prisma.company.upsert({
    where: { yclientsId: SANDBOX_YCLIENTS_ID },
    update: { name: "Алункачева клиник — песочница" },
    create: {
      yclientsId: SANDBOX_YCLIENTS_ID,
      name: "Алункачева клиник — песочница",
      timezone: "Europe/Moscow",
    },
  });
  console.log(`клиника: ${company.name} (${company.id})`);

  const SOURCES = [
    { code: "whatsapp", title: "WhatsApp", kind: "MESSENGER" as const },
    { code: "telegram", title: "Telegram", kind: "MESSENGER" as const },
    { code: "instagram", title: "Instagram", kind: "MESSENGER" as const },
    { code: "call", title: "Звонок", kind: "PHONE" as const },
    { code: "site", title: "Сайт", kind: "WEB" as const },
  ];
  for (const s of SOURCES) {
    await prisma.source.upsert({
      where: { companyId_code: { companyId: company.id, code: s.code } },
      update: {},
      create: { companyId: company.id, ...s },
    });
  }

  for (const s of SERVICES) {
    await prisma.service.upsert({
      where: { companyId_yclientsServiceId: { companyId: company.id, yclientsServiceId: s.yclientsServiceId } },
      update: { title: s.title, price: s.price, durationMin: s.durationMin },
      create: { companyId: company.id, ...s },
    });
  }
  for (const s of STAFF) {
    await prisma.staff.upsert({
      where: { companyId_yclientsStaffId: { companyId: company.id, yclientsStaffId: s.yclientsStaffId } },
      update: { name: s.name },
      create: { companyId: company.id, ...s },
    });
  }
  console.log(`услуг ${SERVICES.length}, специалистов ${STAFF.length}`);

  await prisma.knowledgeEntry.deleteMany({ where: { companyId: company.id } });
  for (const k of KNOWLEDGE) {
    await prisma.knowledgeEntry.create({ data: { companyId: company.id, ...k, isActive: true } });
  }
  console.log(`записей справочника ${KNOWLEDGE.length}`);

  /**
   * Стоп-слова — как у клиники. «Окошко» здесь не случайно: именно из-за него
   * агент оборвал разговор, когда пациентка ответила на сообщение клиники со
   * словом «Окошко» просьбой записать племянника.
   */
  await prisma.setting.upsert({
    where: { companyId_key: { companyId: company.id, key: "assistant" } },
    update: {},
    create: {
      companyId: company.id,
      key: "assistant",
      value: {
        assistant: {
          mode: "on",
          greeting: "Здравствуйте! Это клиника Алункачевой. Чем могу помочь?",
          stopWords: ["окошко", "жалоба", "юрист"],
          prompt: CLINIC_PROMPT,
        },
      },
    },
  });

  await prisma.consentDocument.upsert({
    where: { companyId_version: { companyId: company.id, version: "1" } },
    update: { isActive: true },
    create: {
      companyId: company.id,
      version: "1",
      text: "Согласие на обработку персональных данных",
      policyUrl: "https://alunkachevaclinic.ru/policy",
      isActive: true,
    },
  });

  /**
   * Постоянные пациентки: визит в прошлом и запись впереди.
   *
   * Их несколько и у каждой свой номер намеренно. История разговора у агента
   * общая на пациента, а не на переписку (он помнит человека, а не канал), и
   * с одной карточкой на все сценарии прогон получался нечестным: во втором
   * диалоге агент «помнил» то, что говорил в первом.
   */
  const service = await prisma.service.findFirstOrThrow({
    where: { companyId: company.id, yclientsServiceId: 2 },
  });
  const adult = await prisma.service.findFirstOrThrow({
    where: { companyId: company.id, yclientsServiceId: 1 },
  });
  const staff = await prisma.staff.findFirstOrThrow({
    where: { companyId: company.id, yclientsStaffId: 1 },
  });

  const PATIENTS = [
    { phone: "+79280000001", name: "Гульбара Магомедова" },
    { phone: "+79280000002", name: "Патимат Алиева" },
    { phone: "+79280000003", name: "Аминат Гаджиева" },
    { phone: "+79280000004", name: "Написат Курбанова" },
    { phone: "+79280000005", name: "Сакинат Омарова" },
  ];

  /** Запись впереди — 8 сентября 09:00 по Москве, та самая из живой переписки. */
  const upcoming = new Date("2026-09-08T06:00:00.000Z");

  for (const p of PATIENTS) {
    const existing = await prisma.patientPhone.findUnique({
      where: { companyId_phone: { companyId: company.id, phone: p.phone } },
      select: { patientId: true },
    });
    const patient = existing
      ? await prisma.patient.findUniqueOrThrow({ where: { id: existing.patientId } })
      : await prisma.patient.create({
          data: {
            companyId: company.id,
            name: p.name,
            firstSeenAt: new Date(Date.now() - 90 * 86_400_000),
            phones: { create: { companyId: company.id, phone: p.phone, isPrimary: true } },
          },
        });

    await prisma.appointment.deleteMany({ where: { companyId: company.id, patientId: patient.id } });

    await prisma.appointment.create({
      data: {
        companyId: company.id,
        patientId: patient.id,
        staffId: staff.id,
        primaryServiceId: service.id,
        startAt: upcoming,
        endAt: new Date(upcoming.getTime() + 40 * 60_000),
        createdAtYclients: new Date(Date.now() - 3 * 86_400_000),
        updatedAtYclients: new Date(Date.now() - 3 * 86_400_000),
        durationMin: 40,
        status: "CONFIRMED",
        services: {
          create: { companyId: company.id, serviceId: service.id, priceCharged: 5000, durationMin: 40 },
        },
      },
    });

    const past = new Date(Date.now() - 21 * 86_400_000);
    await prisma.appointment.create({
      data: {
        companyId: company.id,
        patientId: patient.id,
        staffId: staff.id,
        primaryServiceId: adult.id,
        startAt: past,
        endAt: new Date(past.getTime() + 45 * 60_000),
        createdAtYclients: past,
        updatedAtYclients: past,
        durationMin: 45,
        status: "ARRIVED",
        revenue: 8000,
        services: {
          create: { companyId: company.id, serviceId: adult.id, priceCharged: 8000, durationMin: 45 },
        },
      },
    });
    console.log(`пациент: ${p.name} ${p.phone} — визит в прошлом и запись 8 сентября 09:00`);
  }

  console.log("\nпесочница готова. Прогон: npx tsx scripts/agent-drill.ts");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
