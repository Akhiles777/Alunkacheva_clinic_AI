/**
 * Связать учётку врача с его настоящей карточкой из YCLIENTS.
 *
 * У клиники врач заведён дважды: карточка из YCLIENTS, на которую оформлены
 * все приёмы, и карточка, созданная вручную вместе с учёткой для входа. Учётка
 * смотрит на вторую — поэтому «Работа в цифрах» показывает нули, хотя врач
 * принимает каждый день.
 *
 * Автоматически такие пары не ищутся, и это намеренно. Имена записаны
 * по-разному — «Ирина Алилгаджиевна» в YCLIENTS и «Ирина Алункачева» в
 * учётке, — а в клинике две Ирины. Ошибиться здесь значит отдать приёмы,
 * выручку и зарплату чужому человеку. Пару называет человек, скрипт только
 * проверяет и переносит.
 *
 * Переносится всё, что висит на карточке: учётка со всеми правами и паролем,
 * приёмы, ставка, выплаты и кабинет. Логин и пароль при этом не трогаются —
 * у учётки меняется только то, на какого специалиста она указывает.
 *
 * Сначала показывает, потом делает: без --apply ничего не меняется.
 *
 *   npx tsx scripts/staff-link.ts --account="Ирина Алункачева" --into="Ирина Алилгаджиевна"
 *   npx tsx scripts/staff-link.ts --account="Ирина Алункачева" --into="Ирина Алилгаджиевна" --apply
 */
import "dotenv/config";
import { prisma } from "../lib/db";

const APPLY = process.argv.includes("--apply");
const arg = (name: string): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : null;
};

async function main() {
  const accountName = arg("account");
  const intoName = arg("into");
  if (!accountName || !intoName) {
    console.error(
      'нужно указать обе карточки:\n' +
        '  npx tsx scripts/staff-link.ts --account="Ирина Алункачева" --into="Ирина Алилгаджиевна"',
    );
    process.exit(1);
  }

  const company = await prisma.company.findFirstOrThrow({
    where: { yclientsId: { gte: 100 } },
    select: { id: true, name: true },
  });

  const pick = async (name: string) =>
    prisma.staff.findMany({
      where: { companyId: company.id, name, deletedAt: null },
      select: {
        id: true,
        name: true,
        yclientsStaffId: true,
        isActive: true,
        defaultRoomId: true,
        defaultRoom: { select: { name: true } },
        user: { select: { id: true, name: true, login: true, role: true } },
        rate: { select: { id: true } },
        _count: { select: { appointments: true, payouts: true } },
      },
    });

  const [fromRows, intoRows] = await Promise.all([pick(accountName), pick(intoName)]);

  /**
   * Имя должно совпасть ровно с одной карточкой. Иначе непонятно, о ком речь,
   * а цена ошибки здесь — чужие приёмы и чужая зарплата.
   */
  if (fromRows.length !== 1) {
    console.error(`«${accountName}»: найдено карточек ${fromRows.length}, нужна ровно одна`);
    process.exit(1);
  }
  if (intoRows.length !== 1) {
    console.error(`«${intoName}»: найдено карточек ${intoRows.length}, нужна ровно одна`);
    process.exit(1);
  }
  const from = fromRows[0];
  const into = intoRows[0];

  console.log(`клиника: ${company.name}`);
  console.log(APPLY ? "режим: ПЕРЕНОСИМ\n" : "режим: только показать (--apply чтобы применить)\n");
  console.log(`откуда: «${from.name}» — YCLIENTS ${from.yclientsStaffId ?? "нет"}, приёмов ${from._count.appointments}` +
    `${from.user ? `, учётка ${from.user.login} (${from.user.role})` : ", учётки нет"}` +
    `${from.rate ? ", есть ставка" : ""}${from._count.payouts ? `, выплат ${from._count.payouts}` : ""}`);
  console.log(`куда:   «${into.name}» — YCLIENTS ${into.yclientsStaffId ?? "нет"}, приёмов ${into._count.appointments}` +
    `${into.user ? `, учётка ${into.user.login} (${into.user.role})` : ", учётки нет"}` +
    `${into.rate ? ", есть ставка" : ""}\n`);

  // ── Проверки, после которых перенос безопасен
  const problems: string[] = [];
  if (from.id === into.id) problems.push("это одна и та же карточка");
  if (into.yclientsStaffId === null) {
    problems.push(
      `«${into.name}» не связана с YCLIENTS. Главной должна быть та карточка, ` +
        "на которую приезжают визиты, иначе выгрузка заведёт третью.",
    );
  }
  if (into.user && from.user && into.user.id !== from.user.id) {
    problems.push(
      `у «${into.name}» уже есть учётка ${into.user.login}. Перенос затёр бы её — ` +
        "разберитесь, чья она, вручную.",
    );
  }
  if (problems.length > 0) {
    console.error("НЕ переносим:");
    for (const p of problems) console.error(`  • ${p}`);
    process.exit(1);
  }

  // ── Что произойдёт
  const plan: string[] = [];
  if (from.user) plan.push(`учётка «${from.user.name}» (${from.user.login}) станет смотреть на «${into.name}» — логин и пароль не меняются`);
  if (from._count.appointments > 0) plan.push(`приёмов переносится: ${from._count.appointments}`);
  if (from.rate && !into.rate) plan.push("ставка переносится");
  if (from.rate && into.rate) plan.push("ставка НЕ переносится: у главной карточки своя, она точнее");
  if (from._count.payouts > 0) plan.push(`выплат переносится: ${from._count.payouts}`);
  if (from.defaultRoomId && !into.defaultRoomId) plan.push(`кабинет «${from.defaultRoom?.name}» переносится`);
  if (from.defaultRoomId && into.defaultRoomId) {
    plan.push(`кабинет НЕ переносится: у главной уже «${into.defaultRoom?.name}»`);
  }
  plan.push(`карточка «${from.name}» убирается из списков (мягкое удаление, данные остаются)`);

  console.log("что произойдёт:");
  for (const p of plan) console.log(`  • ${p}`);

  console.log(
    "\nчто НЕ изменится: логин, пароль и права учётки; приёмы, выручка и история\n" +
      `главной карточки; расписание и кабинеты в YCLIENTS.\n` +
      `В расписании и отчётах врач будет называться «${into.name}» — так он записан\n` +
      "в YCLIENTS, а расписание ведёт он (§2).",
  );

  if (!APPLY) {
    console.log("\nничего не изменено. Повторите с --apply.");
    await prisma.$disconnect();
    return;
  }

  /**
   * Одной транзакцией: половина переноса хуже, чем ни одной. Учётка без
   * приёмов и приёмы без учётки — оба состояния чинятся руками.
   */
  await prisma.$transaction(async (tx) => {
    if (from._count.appointments > 0) {
      await tx.appointment.updateMany({
        where: { companyId: company.id, staffId: from.id },
        data: { staffId: into.id },
      });
    }
    if (from._count.payouts > 0) {
      await tx.payrollPayout.updateMany({
        where: { companyId: company.id, staffId: from.id },
        data: { staffId: into.id },
      });
    }
    if (from.rate && !into.rate) {
      await tx.staffRate.update({ where: { staffId: from.id }, data: { staffId: into.id } });
    }
    if (from.defaultRoomId && !into.defaultRoomId) {
      await tx.staff.update({ where: { id: into.id }, data: { defaultRoomId: from.defaultRoomId } });
    }
    /**
     * Учётку переносим ПОСЛЕ того, как освободили карточку: ссылка на
     * специалиста уникальна, и две учётки на одной карточке база не примет.
     */
    await tx.staff.update({
      where: { id: from.id },
      data: { deletedAt: new Date(), isActive: false, defaultRoomId: null },
    });
    if (from.user) {
      await tx.staffUser.update({ where: { id: from.user.id }, data: { staffId: into.id } });
    }
  });

  console.log("\nготово. Проверьте карточку сотрудника — «Работа в цифрах» должна ожить.");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
