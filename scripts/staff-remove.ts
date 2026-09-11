/**
 * Убрать учётную запись сотрудника.
 *
 * Нужен для тестовых учёток, заведённых при настройке: они висят в списках, их
 * видно в разделе учёта, и на вопрос «кто вообще имеет доступ» они отвечают
 * неправдой.
 *
 * УДАЛЕНИЕ МЯГКОЕ. Учётка помечается `deletedAt` и выключается — войти по ней
 * больше нельзя, но её следы в журнале действий, в заметках и в передачах
 * смены остаются на своих местах. Жёсткое удаление утащило бы за собой
 * историю: кто отправил сообщение пациенту, кто менял настройки. Историю
 * клиники нельзя терять ради порядка в списке (§4).
 *
 * По умолчанию только показывает, что будет сделано. Запись — по `--apply`.
 *
 *   npx tsx scripts/staff-remove.ts                       # кто есть
 *   npx tsx scripts/staff-remove.ts "Гаджибутта Алункачев" "Абдурахмар"
 *   npx tsx scripts/staff-remove.ts "Абдурахмар" --apply
 */
import "dotenv/config";
import { prisma } from "../lib/db";

async function main() {
  const apply = process.argv.includes("--apply");
  const names = process.argv.slice(2).filter((a) => !a.startsWith("--"));

  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const all = await prisma.staffUser.findMany({
    where: { companyId: company.id },
    orderBy: [{ deletedAt: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      login: true,
      role: true,
      isActive: true,
      deletedAt: true,
      lastLoginAt: true,
      _count: { select: { auditLogs: true } },
    },
  });

  console.log(`клиника: ${company.name}\n`);
  console.log("── УЧЁТНЫЕ ЗАПИСИ");
  for (const u of all) {
    const state = u.deletedAt ? "УДАЛЕНА" : u.isActive ? "активна" : "выключена";
    const last = u.lastLoginAt ? u.lastLoginAt.toISOString().slice(0, 10) : "ни разу";
    console.log(
      `  ${u.name.padEnd(30)} ${u.role.padEnd(8)} ${state.padEnd(9)} вход: ${last.padEnd(11)} действий: ${u._count.auditLogs}`,
    );
  }

  if (names.length === 0) {
    console.log("\nЧтобы убрать — назовите имена точно как выше:");
    console.log('  npx tsx scripts/staff-remove.ts "Имя Фамилия" --apply');
    return;
  }

  console.log("\n── ЧТО БУДЕТ СДЕЛАНО");
  const targets = [];
  for (const name of names) {
    const found = all.filter((u) => u.name.trim() === name.trim() && !u.deletedAt);
    if (found.length === 0) {
      console.log(`  «${name}» — не найдена (или уже убрана). Имя должно совпадать дословно.`);
      continue;
    }
    /**
     * Тёзки — повод остановиться, а не выбрать наугад.
     *
     * В списке клиники есть «Ирина Алункачева» дважды, с разными ролями.
     * Убрать не ту учётку значит отобрать доступ у работающего человека.
     */
    if (found.length > 1) {
      console.log(`  «${name}» — таких ${found.length}, по имени не различить:`);
      for (const u of found) console.log(`      роль ${u.role}, логин ${u.login}, id ${u.id}`);
      console.log("      Уберите по логину: скрипт принимает и логин тоже.");
      continue;
    }
    const u = found[0];
    console.log(
      `  «${u.name}» (${u.role}, логин ${u.login}) → будет помечена удалённой и выключена.` +
        ` Её ${u._count.auditLogs} записей в журнале остаются на месте.`,
    );
    targets.push(u);
  }

  // Логин как запасной способ: имена бывают одинаковые, логины — нет.
  for (const name of names) {
    const byLogin = all.find((u) => u.login === name.trim() && !u.deletedAt);
    if (byLogin && !targets.some((t) => t.id === byLogin.id)) {
      console.log(`  логин «${byLogin.login}» (${byLogin.name}) → будет помечена удалённой.`);
      targets.push(byLogin);
    }
  }

  if (targets.length === 0) {
    console.log("\nНечего убирать.");
    return;
  }

  if (!apply) {
    console.log("\nСухой прогон. Ничего не изменено. Повторите с --apply.");
    return;
  }

  for (const u of targets) {
    await prisma.staffUser.update({
      where: { id: u.id },
      data: { deletedAt: new Date(), isActive: false },
    });
    console.log(`  убрана: ${u.name}`);
  }
  console.log(`\nГотово: ${targets.length}. Войти по этим учёткам больше нельзя.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
