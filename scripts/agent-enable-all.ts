/**
 * Вернуть агента во все диалоги.
 *
 * Кнопка «Выключить агента» ставит отметку в одном диалоге. Из-за ошибки в
 * условии запроса — `id: undefined` в Prisma не сужает выборку, а снимает
 * условие — одно нажатие погасило агента во всех переписках клиники. Условие
 * теперь защищено проверкой, но уже проставленные отметки надо снять.
 *
 * Скрипт показывает, сколько диалогов выключено, и по `--apply` снимает
 * отметку. Переписку и статусы не трогает: снимается только запрет отвечать.
 *
 *   npx tsx scripts/agent-enable-all.ts           # посмотреть
 *   npx tsx scripts/agent-enable-all.ts --apply
 *   npx tsx scripts/agent-enable-all.ts --apply --keep=cln123,cln456
 */
import "dotenv/config";
import { prisma } from "../lib/db";

async function main() {
  const apply = process.argv.includes("--apply");
  /** Диалоги, где агент выключен намеренно и должен остаться выключенным. */
  const keep = new Set(
    (process.argv.find((a) => a.startsWith("--keep="))?.slice(7) ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const off = await prisma.conversation.findMany({
    where: { companyId: company.id, agentDisabled: true, deletedAt: null },
    orderBy: { lastMessageAt: "desc" },
    select: {
      id: true,
      channel: true,
      contactName: true,
      lastMessageAt: true,
      patient: { select: { name: true } },
    },
  });

  console.log(`клиника: ${company.name}`);
  console.log(`диалогов с выключенным агентом: ${off.length}\n`);
  for (const c of off.slice(0, 20)) {
    const who = c.patient?.name ?? c.contactName ?? "без имени";
    const at = c.lastMessageAt.toISOString().slice(0, 16).replace("T", " ");
    console.log(`  ${c.id} · ${c.channel} · ${who} · последнее ${at}${keep.has(c.id) ? "  (оставляем)" : ""}`);
  }
  if (off.length > 20) console.log(`  … и ещё ${off.length - 20}`);

  if (off.length === 0) {
    console.log("\nВыключенных диалогов нет — агент работает везде.");
    return;
  }
  if (!apply) {
    console.log("\nсухой прогон: ничего не изменено");
    console.log("включить всем:      npx tsx scripts/agent-enable-all.ts --apply");
    console.log("оставить выключенным конкретные: --apply --keep=<id>,<id>");
    return;
  }

  const ids = off.map((c) => c.id).filter((id) => !keep.has(id));
  if (ids.length === 0) {
    console.log("\nВсе выключенные диалоги в списке исключений — менять нечего.");
    return;
  }
  const res = await prisma.conversation.updateMany({
    // Явный список идентификаторов: пустым он быть не может — проверено выше.
    where: { id: { in: ids }, companyId: company.id },
    data: { agentDisabled: false },
  });
  console.log(`\nвключено диалогов: ${res.count}`);
  console.log("Переписка и статусы не изменились — снят только запрет отвечать.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
