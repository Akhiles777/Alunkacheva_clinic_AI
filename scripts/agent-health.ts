/**
 * Где останавливается ответ агента.
 *
 * «Бот не работает» — это пять разных мест на пути от сообщения пациента до
 * сообщения в мессенджере: вебхук не принёс, агент промолчал намеренно, модель
 * не ответила, канал не принял отправку, отправка ушла и потерялась. Со
 * стороны все пять выглядят одинаково, и различает их только состояние.
 *
 * Скрипт идёт по этому пути и на каждом шаге показывает числа за сутки. Он не
 * чинит ничего — он отвечает на вопрос «где обрыв», чтобы чинить не наугад.
 *
 *   npx tsx scripts/agent-health.ts        # за 24 часа
 *   npx tsx scripts/agent-health.ts 72
 */
import "dotenv/config";
import { prisma } from "../lib/db";

const when = (at: Date | null | undefined) =>
  at ? at.toISOString().slice(0, 16).replace("T", " ") : "никогда";

async function main() {
  const hours = Number(process.argv[2] ?? 24);
  const since = new Date(Date.now() - hours * 3600 * 1000);
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

  console.log(`клиника: ${company.name}`);
  console.log(`период: последние ${hours} ч (с ${when(since)})\n`);

  // ── 1. режим ассистента: общий выключатель
  const setting = await prisma.setting.findUnique({
    where: { companyId_key: { companyId: company.id, key: "assistant" } },
    select: { value: true },
  });
  const cfg = (setting?.value as { assistant?: { mode?: string; stopWords?: string[] } } | null)
    ?.assistant;
  const mode = cfg?.mode ?? "on";
  console.log("── 1. РЕЖИМ АССИСТЕНТА");
  console.log(`  ${mode}${mode === "on" ? "" : "  ← агент сам не отвечает"}`);
  if (cfg?.stopWords?.length) {
    console.log(`  стоп-слова: ${cfg.stopWords.join(", ")} — на них агент передаёт человеку`);
  }

  // ── 2. дошли ли сообщения до нас
  const incoming = await prisma.message.groupBy({
    by: ["channel"],
    where: {
      companyId: company.id,
      direction: "IN",
      authorType: "PATIENT",
      deletedAt: null,
      createdAt: { gte: since },
    },
    _count: { _all: true },
  });
  console.log("\n── 2. ВХОДЯЩИЕ ОТ ПАЦИЕНТОВ");
  if (incoming.length === 0) {
    console.log("  ни одного. Либо не писали, либо вебхуки не доходят.");
  } else {
    for (const r of incoming) console.log(`  ${r.channel.padEnd(10)} ${r._count._all}`);
  }

  // ── 3. что решил агент
  const runs = await prisma.agentRun.groupBy({
    by: ["outcome"],
    where: { companyId: company.id, triggeredAt: { gte: since } },
    _count: { _all: true },
  });
  console.log("\n── 3. ПОПЫТКИ АГЕНТА");
  if (runs.length === 0) {
    console.log("  ни одной. Агент не дошёл до решения — смотрите шаги 1 и 2.");
  } else {
    for (const r of runs) {
      const hint =
        r.outcome === "SUPPRESSED"
          ? "  ← намеренное молчание: пауза, выключен в диалоге или сообщение старше возврата"
          : r.outcome === "ESCALATED"
            ? "  ← передал человеку (штатно)"
            : r.outcome === "TIMEOUT" || r.outcome === "PROVIDER_ERROR"
              ? "  ← модель не ответила"
              : "";
      console.log(`  ${r.outcome.padEnd(16)} ${String(r._count._all).padStart(4)}${hint}`);
    }
  }
  const lastRun = await prisma.agentRun.findFirst({
    where: { companyId: company.id },
    orderBy: { triggeredAt: "desc" },
    select: { triggeredAt: true, outcome: true, errorText: true },
  });
  if (lastRun) {
    console.log(
      `  последняя попытка: ${when(lastRun.triggeredAt)} · ${lastRun.outcome}` +
        (lastRun.errorText ? ` · ${lastRun.errorText}` : ""),
    );
  }

  // ── 4. ушли ли ответы
  const outgoing = await prisma.message.groupBy({
    by: ["channel", "status"],
    where: {
      companyId: company.id,
      direction: "OUT",
      authorType: "BOT",
      deletedAt: null,
      createdAt: { gte: since },
    },
    _count: { _all: true },
  });
  console.log("\n── 4. ОТВЕТЫ АГЕНТА В КАНАЛ");
  if (outgoing.length === 0) {
    console.log("  ни одного. Агент ничего не отправлял — смотрите шаг 3.");
  } else {
    for (const r of outgoing) {
      const mark = r.status === "SENT" ? "✓" : r.status === "FAILED" ? "✗" : "·";
      console.log(`  ${mark} ${r.channel.padEnd(10)} ${r.status.padEnd(8)} ${r._count._all}`);
    }
    const failed = await prisma.message.findMany({
      where: {
        companyId: company.id,
        direction: "OUT",
        status: "FAILED",
        createdAt: { gte: since },
      },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: { channel: true, createdAt: true, failureReason: true },
    });
    if (failed.length > 0) {
      console.log("\n  почему не ушли:");
      for (const f of failed) {
        console.log(`    ${when(f.createdAt)} ${f.channel} — ${f.failureReason ?? "причина не записана"}`);
      }
    }
  }

  // ── 5. диалоги, где агент молчит по состоянию
  const now = new Date();
  const [disabled, paused, escalated] = await Promise.all([
    prisma.conversation.count({ where: { companyId: company.id, agentDisabled: true, deletedAt: null } }),
    prisma.conversation.count({
      where: { companyId: company.id, botPausedUntil: { gt: now }, deletedAt: null },
    }),
    prisma.conversation.count({
      where: {
        companyId: company.id,
        deletedAt: null,
        escalations: { some: { status: { not: "RESOLVED" } } },
      },
    }),
  ]);
  const total = await prisma.conversation.count({
    where: { companyId: company.id, deletedAt: null },
  });
  console.log("\n── 5. ГДЕ АГЕНТ МОЛЧИТ ПО СОСТОЯНИЮ");
  console.log(`  диалогов всего:            ${total}`);
  console.log(`  выключен человеком:        ${disabled}`);
  console.log(`  на паузе после перехвата:  ${paused}`);
  console.log(`  с открытой эскалацией:     ${escalated}`);
  if (disabled > 0) {
    const rows = await prisma.conversation.findMany({
      where: { companyId: company.id, agentDisabled: true, deletedAt: null },
      take: 10,
      select: { id: true, channel: true, contactName: true, patient: { select: { name: true } } },
    });
    for (const c of rows) {
      console.log(`    ${c.id} · ${c.channel} · ${c.patient?.name ?? c.contactName ?? "без имени"}`);
    }
    console.log("    вернуть: npx tsx scripts/agent-enable-all.ts --apply");
  }

  // ── 6. вывод
  console.log("\n── ЧТО ЭТО ЗНАЧИТ");
  const inCount = incoming.reduce((s, r) => s + r._count._all, 0);
  const sent = outgoing.filter((r) => r.status === "SENT").reduce((s, r) => s + r._count._all, 0);
  const failedCount = outgoing
    .filter((r) => r.status === "FAILED")
    .reduce((s, r) => s + r._count._all, 0);

  if (mode !== "on") {
    console.log("  Агент выключен в настройках целиком — это главная причина, остальное вторично.");
  } else if (inCount === 0) {
    console.log("  Пациенты не писали (или вебхуки не доходят). Агенту нечего было отвечать.");
  } else if (runs.length === 0) {
    console.log("  Сообщения приходят, но агент до решения не доходит — смотрите журнал сервера.");
  } else if (sent === 0 && failedCount > 0) {
    console.log("  Агент отвечает, но канал не принимает отправку: дело в связи с провайдером,");
    console.log("  а не в самом агенте. Причины — в шаге 4.");
  } else {
    console.log(`  Агент отвечает: доставлено ${sent}, не доставлено ${failedCount}.`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
