/**
 * Проверка пересчёта источника первого обращения — на живой базе песочницы.
 *
 * Чистая функция (`lib/metrics/patient-source.ts`) покрыта тестами, но между
 * ней и базой лежит сборка касаний: диалоги, самое раннее входящее, звонки.
 * Ровно там и живут дефекты, которых в тестах не видно.
 *
 * Проверяем три вещи, каждая из которых — требование заказчика:
 *   — источник выводится по самому раннему касанию;
 *   — ручная отметка НЕ перетирается ни при каких условиях;
 *   — повторный прогон не меняет ничего (идемпотентность).
 *
 * Работает только на песочнице: предохранитель тот же, что у посева, — живая
 * клиника определяется по содержимому, а не по адресу базы.
 *
 *   npx tsx scripts/patient-source-check.ts
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { recomputePatientSources } from "../lib/metrics/recompute";
import { SANDBOX_YCLIENTS_ID } from "./sandbox-id";

async function assertSandbox() {
  const live = await prisma.company.findFirst({
    where: { yclientsId: { gte: 100 } },
    select: { id: true, name: true },
  });
  if (live) {
    const visits = await prisma.appointment.count({ where: { companyId: live.id } });
    if (visits > 0) {
      console.error(`ЭТО БОЕВАЯ БАЗА: клиника «${live.name}», визитов ${visits}. Проверка не идёт.`);
      process.exit(1);
    }
  }
}

const PREFIX = "src-check-";

async function main() {
  await assertSandbox();
  const company = await prisma.company.findFirstOrThrow({
    where: { yclientsId: SANDBOX_YCLIENTS_ID },
    select: { id: true },
  });
  const companyId = company.id;

  const call = await prisma.source.findFirstOrThrow({ where: { companyId, code: "call" } });
  const ig = await prisma.source.findFirstOrThrow({ where: { companyId, code: "instagram" } });

  // Чистим следы прошлой проверки: это её собственные строки, не данные клиники.
  await prisma.message.deleteMany({ where: { conversationId: { startsWith: PREFIX } } });
  await prisma.callLog.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.conversation.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.patient.deleteMany({ where: { id: { startsWith: PREFIX } } });

  const mk = async (id: string, extra: Record<string, unknown> = {}) =>
    prisma.patient.create({
      data: {
        id: PREFIX + id,
        companyId,
        name: `Проверка ${id}`,
        firstSeenAt: new Date("2026-01-01T00:00:00Z"),
        ...extra,
      },
      select: { id: true },
    });

  // 1. Переписка в WhatsApp позже звонка — победить должен звонок.
  const a = await mk("a");
  await prisma.conversation.create({
    data: {
      id: PREFIX + "conv-a",
      companyId,
      patientId: a.id,
      channel: "WHATSAPP",
      externalUserId: PREFIX + "a",
      status: "BOT_ACTIVE",
      startedAt: new Date("2026-02-01T10:00:00Z"),
      lastMessageAt: new Date("2026-02-01T10:00:00Z"),
      messages: {
        create: {
          companyId,
          channel: "WHATSAPP",
          direction: "IN",
          authorType: "PATIENT",
          body: "здравствуйте",
          createdAt: new Date("2026-02-01T10:00:00Z"),
        },
      },
    },
  });
  await prisma.callLog.create({
    data: {
      id: PREFIX + "call-a",
      companyId,
      patientId: a.id,
      phone: "+79990000001",
      direction: "IN",
      createdAt: new Date("2026-01-15T09:00:00Z"),
    },
  });

  // 2. Только переписка в Instagram.
  const b = await mk("b");
  await prisma.conversation.create({
    data: {
      id: PREFIX + "conv-b",
      companyId,
      patientId: b.id,
      channel: "INSTAGRAM",
      externalUserId: PREFIX + "b",
      status: "BOT_ACTIVE",
      startedAt: new Date("2026-03-01T10:00:00Z"),
      lastMessageAt: new Date("2026-03-01T10:00:00Z"),
      messages: {
        create: {
          companyId,
          channel: "INSTAGRAM",
          direction: "IN",
          authorType: "PATIENT",
          body: "сколько стоит",
          createdAt: new Date("2026-03-01T10:00:00Z"),
        },
      },
    },
  });

  // 3. Ручная отметка администратора при живой переписке в WhatsApp.
  const c = await mk("c", { sourceId: ig.id, sourceConfidence: "MANUAL" });
  await prisma.conversation.create({
    data: {
      id: PREFIX + "conv-c",
      companyId,
      patientId: c.id,
      channel: "WHATSAPP",
      externalUserId: PREFIX + "c",
      status: "BOT_ACTIVE",
      startedAt: new Date("2026-02-10T10:00:00Z"),
      lastMessageAt: new Date("2026-02-10T10:00:00Z"),
      messages: {
        create: {
          companyId,
          channel: "WHATSAPP",
          direction: "IN",
          authorType: "PATIENT",
          body: "добрый день",
          createdAt: new Date("2026-02-10T10:00:00Z"),
        },
      },
    },
  });

  // 4. Ни переписки, ни звонков — источник обязан остаться неизвестным.
  const d = await mk("d");

  const first = await recomputePatientSources(companyId);
  const second = await recomputePatientSources(companyId);

  const read = async (id: string) =>
    prisma.patient.findUniqueOrThrow({
      where: { id },
      select: { sourceId: true, sourceConfidence: true },
    });

  const ra = await read(a.id);
  const rb = await read(b.id);
  const rc = await read(c.id);
  const rd = await read(d.id);

  const checks: [string, boolean, string][] = [
    ["звонок раньше переписки — источник «Звонок»", ra.sourceId === call.id, String(ra.sourceId)],
    ["вывод помечен DERIVED", ra.sourceConfidence === "DERIVED", ra.sourceConfidence],
    ["только переписка — источник её канала", rb.sourceId === ig.id, String(rb.sourceId)],
    ["ручная отметка не перетёрта", rc.sourceId === ig.id && rc.sourceConfidence === "MANUAL", `${rc.sourceId} ${rc.sourceConfidence}`],
    ["касаний нет — источник неизвестен", rd.sourceId === null, String(rd.sourceId)],
    ["второй прогон ничего не изменил", second.derived === 0 && second.dialogsFilled === 0, `derived ${second.derived}, dialogs ${second.dialogsFilled}`],
    ["диалогам проставлен источник по каналу", first.dialogsFilled >= 3, String(first.dialogsFilled)],
  ];

  let bad = 0;
  for (const [what, ok, got] of checks) {
    console.log(`${ok ? "  ок  " : "ПЛОХО"}  ${what}${ok ? "" : `  — получили: ${got}`}`);
    if (!ok) bad += 1;
  }

  // Убираем за собой: это строки самой проверки, а не данные клиники.
  await prisma.message.deleteMany({ where: { conversationId: { startsWith: PREFIX } } });
  await prisma.callLog.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.conversation.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.patient.deleteMany({ where: { id: { startsWith: PREFIX } } });

  console.log(bad === 0 ? "\nвсё сошлось" : `\nнесошедшихся проверок: ${bad}`);
  if (bad > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
