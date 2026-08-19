/**
 * Задвоенные услуги: почему привязка к кабинету не работает.
 *
 * В справочнике клиники одна и та же услуга встречается дважды: «Инфузия
 * "Био-Ресурс"», «Пакет "PRO"», «Нейромедитация», «Консультация». Одна строка
 * заведена руками в настройках — у неё проставлен кабинет; вторая приехала из
 * YCLIENTS — у неё есть yclientsServiceId, и именно на неё ссылаются визиты.
 *
 * Отсюда и загадка «процедурный кабинет 0%»: кабинет привязан к строке, на
 * которую не ссылается ни один визит, а визиты идут через строку без кабинета.
 *
 * Правильная сторона всегда одна — та, что связана с YCLIENTS: он источник
 * истины по услугам и записям (§2). Скрипт переносит на неё привязки к
 * кабинетам с ручного дубля, а сам дубль выключает — но только если на нём нет
 * визитов. Удалять ничего не удаляем: мягкое выключение обратимо, а потеря
 * связей визитов — нет.
 *
 *   npx tsx scripts/services-dedupe.ts           # показать
 *   npx tsx scripts/services-dedupe.ts --apply
 */
import "dotenv/config";
import { prisma } from "../lib/db";

/** «Инфузия "Био-Ресурс"» и «инфузия био-ресурс» — одна услуга. */
function key(title: string): string {
  return title
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

async function main() {
  const apply = process.argv.includes("--apply");
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

  const services = await prisma.service.findMany({
    where: { companyId: company.id },
    select: {
      id: true,
      title: true,
      yclientsServiceId: true,
      isActive: true,
      rooms: { select: { roomId: true } },
      /**
       * Визиты считаем по обеим связям. Состав визита раньше не заполнялся, и
       * проверка «есть ли визиты» смотрела только на основную услугу; теперь
       * услуга может быть второй в записи — тогда она видна только здесь.
       */
      _count: { select: { primaryForAppointments: true, appointmentServices: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`клиника: ${company.name}`);
  console.log(`услуг в справочнике: ${services.length}`);
  console.log(`  из них связаны с YCLIENTS: ${services.filter((s) => s.yclientsServiceId !== null).length}`);
  console.log(`  заведены у нас: ${services.filter((s) => s.yclientsServiceId === null).length}`);

  const groups = new Map<string, typeof services>();
  for (const s of services) {
    const k = key(s.title);
    const list = groups.get(k) ?? [];
    list.push(s);
    groups.set(k, list);
  }

  const dupes = [...groups.entries()].filter(([, list]) => list.length > 1);
  console.log(`\n═══ ЗАДВОЕННЫЕ НАЗВАНИЯ: ${dupes.length} ═══`);

  let moved = 0;
  let disabled = 0;
  let blocked = 0;

  for (const [, list] of dupes) {
    // Правильная строка — связанная с YCLIENTS: на неё ссылаются визиты.
    const main = list.find((s) => s.yclientsServiceId !== null);
    const extras = list.filter((s) => s !== main);
    if (!main) {
      console.log(`  ${list[0].title.slice(0, 40)} — обе строки заведены у нас, пропускаем`);
      continue;
    }

    for (const extra of extras) {
      const withRooms = extra.rooms.length > 0 && main.rooms.length === 0;
      const visits = Math.max(
        extra._count.primaryForAppointments,
        extra._count.appointmentServices,
      );
      const hasVisits = visits > 0;

      console.log(
        `  ${main.title.slice(0, 40).padEnd(42)} дубль: визитов ${visits}, ` +
          `кабинетов ${extra.rooms.length}${withRooms ? " → перенесём" : ""}` +
          `${hasVisits ? " · на дубле есть визиты, выключать не будем" : ""}`,
      );

      if (!apply) continue;

      if (withRooms) {
        for (const link of extra.rooms) {
          await prisma.serviceRoom
            .create({ data: { companyId: company.id, serviceId: main.id, roomId: link.roomId } })
            .catch(() => {});
        }
        moved += 1;
      }
      if (hasVisits) {
        blocked += 1;
        continue;
      }
      await prisma.service.update({ where: { id: extra.id }, data: { isActive: false } });
      disabled += 1;
    }
  }

  if (!apply) {
    console.log("\nэто предварительный просмотр. чтобы применить: --apply");
    await prisma.$disconnect();
    return;
  }

  console.log(
    `\nперенесено привязок к кабинетам: ${moved}; выключено дублей: ${disabled}; ` +
      `оставлено как есть (на дубле есть визиты): ${blocked}`,
  );
  console.log("Чтобы кабинеты проставились визитам: npx tsx scripts/yclients-resync.ts --apply");

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("не удалось:", e);
  await prisma.$disconnect();
  process.exit(1);
});
