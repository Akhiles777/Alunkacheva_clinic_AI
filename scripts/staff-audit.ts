/**
 * Почему в карточке сотрудника нули.
 *
 * Приёмы оформляются на карточку специалиста (Staff), а учётка сотрудника
 * (StaffUser) на неё ссылается. Если ссылка ведёт не на ту карточку, метрики
 * честно показывают ноль: у ЭТОЙ карточки приёмов действительно нет.
 *
 * Так бывает, когда специалист задвоен: одну карточку клиника завела руками в
 * настройках, вторая приехала из YCLIENTS под тем же именем. Визиты ссылаются
 * на приезжую, учётка — на заведённую. Ровно так же однажды задвоились услуги,
 * и кабинет визита переставал находиться.
 *
 * Скрипт показывает всё, что нужно для вывода: у кого сколько приёмов, кто с
 * кем задвоен, какие учётки смотрят в пустоту. С --apply объединяет задвоенные
 * карточки: приёмы, учётку и кабинет переносит на ту, что связана с YCLIENTS,
 * лишнюю мягко удаляет.
 *
 *   npx tsx scripts/staff-audit.ts
 *   npx tsx scripts/staff-audit.ts --apply
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { normalizeTitle } from "../lib/integrations/yclients/adopt";

const APPLY = process.argv.includes("--apply");

async function main() {
  const company = await prisma.company.findFirstOrThrow({
    where: { yclientsId: { gte: 100 } },
    select: { id: true, name: true },
  });
  console.log(`клиника: ${company.name}`);
  console.log(APPLY ? "режим: ИЗМЕНЯЕМ данные\n" : "режим: только показать (--apply чтобы применить)\n");

  const since = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  const staff = await prisma.staff.findMany({
    where: { companyId: company.id, deletedAt: null },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      yclientsStaffId: true,
      isActive: true,
      defaultRoom: { select: { name: true } },
      user: { select: { id: true, name: true, role: true } },
      _count: { select: { appointments: { where: { deletedAt: null } } } },
    },
  });

  // Приёмы за тот же период, что показывает карточка сотрудника.
  const recent = await prisma.appointment.groupBy({
    by: ["staffId"],
    where: { companyId: company.id, deletedAt: null, startAt: { gte: since } },
    _count: { _all: true },
  });
  const recentBy = new Map(recent.map((r) => [r.staffId, r._count._all]));

  console.log("── специалисты ──");
  for (const s of staff) {
    const marks = [
      s.yclientsStaffId === null ? "НЕ связан с YCLIENTS" : `YCLIENTS ${s.yclientsStaffId}`,
      s.isActive ? null : "выключен",
      s.user ? `учётка: ${s.user.name} (${s.user.role})` : null,
      s.defaultRoom ? `кабинет: ${s.defaultRoom.name}` : null,
    ].filter(Boolean);
    console.log(
      `  ${s.name} — приёмов всего ${s._count.appointments}, за 90 дней ${recentBy.get(s.id) ?? 0}` +
        `\n      ${marks.join(" · ")}`,
    );
  }

  // ── Задвоенные: одно имя, две карточки
  const byName = new Map<string, typeof staff>();
  for (const s of staff) {
    const key = normalizeTitle(s.name);
    byName.set(key, [...(byName.get(key) ?? []), s]);
  }
  const dups = [...byName.values()].filter((rows) => rows.length > 1);

  console.log("\n── задвоенные карточки ──");
  if (dups.length === 0) console.log("  нет");
  for (const rows of dups) {
    console.log(`  ${rows[0].name}:`);
    for (const r of rows) {
      console.log(
        `      ${r.yclientsStaffId ?? "без номера YCLIENTS"} · приёмов ${r._count.appointments}` +
          `${r.user ? ` · учётка ${r.user.name}` : ""}`,
      );
    }
  }

  // ── Учётки, смотрящие в пустоту
  console.log("\n── учётки без приёмов ──");
  const blind = staff.filter((s) => s.user && s._count.appointments === 0);
  if (blind.length === 0) console.log("  нет");
  for (const s of blind) {
    console.log(
      `  ${s.user!.name} → карточка «${s.name}» (${s.yclientsStaffId ?? "без номера YCLIENTS"}): приёмов ноль.` +
        "\n      Карточка «Работа в цифрах» у него будет пустой — приёмы оформлены на другую карточку.",
    );
  }

  if (!APPLY) {
    if (dups.length > 0) {
      console.log(
        "\nЧто сделает --apply: перенесёт приёмы, учётку и кабинет на карточку с номером\n" +
          "YCLIENTS, а лишнюю мягко удалит. Расписание ведёт YCLIENTS (§2), поэтому\n" +
          "главной остаётся его карточка.",
      );
    }
    await prisma.$disconnect();
    return;
  }

  for (const rows of dups) {
    /**
     * Главной делаем карточку с номером YCLIENTS: расписание ведёт он (§2), и
     * все будущие визиты приедут именно на неё. Если таких две — не трогаем:
     * это разные люди с одинаковыми именами, и объединять их нельзя.
     */
    const linked = rows.filter((r) => r.yclientsStaffId !== null);
    if (linked.length !== 1) {
      console.log(`  ${rows[0].name}: пропускаем — ${linked.length} карточек с номером YCLIENTS`);
      continue;
    }
    const keep = linked[0];
    const drop = rows.filter((r) => r.id !== keep.id);

    for (const d of drop) {
      const moved = await prisma.appointment.updateMany({
        where: { companyId: company.id, staffId: d.id },
        data: { staffId: keep.id },
      });
      if (d.user) {
        await prisma.staffUser.update({ where: { id: d.user.id }, data: { staffId: keep.id } });
      }
      // Кабинет переносим, только если у главной его нет: своё значение точнее.
      if (!keep.defaultRoom && d.defaultRoom) {
        const room = await prisma.room.findFirst({
          where: { companyId: company.id, name: d.defaultRoom.name },
          select: { id: true },
        });
        if (room) await prisma.staff.update({ where: { id: keep.id }, data: { defaultRoomId: room.id } });
      }
      await prisma.staff.update({
        where: { id: d.id },
        data: { deletedAt: new Date(), isActive: false, defaultRoomId: null },
      });
      console.log(`  ${rows[0].name}: перенесено приёмов ${moved.count}, лишняя карточка убрана`);
    }
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
