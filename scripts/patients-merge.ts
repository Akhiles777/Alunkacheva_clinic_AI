/**
 * Склеить задвоенные карточки пациента.
 *
 * Один человек оказывается в базе дважды: у клиники две карточки в YCLIENTS,
 * телефон в одной записан с ошибкой, либо карточку успел завести агент до
 * того, как человек назвал номер. Внешне это выглядит так, что визиты у
 * пациента есть, а карточка пустая — открыли не ту.
 *
 * Скрипт переносит всё с пустой карточки на ту, где визиты, и мягко удаляет
 * пустую. Мягко (§4): карточка пациента исчезнуть насовсем не должна.
 *
 * Пары ищем по телефону в E.164 — единственному надёжному ключу (§4). Имя
 * ключом не бывает: тёзок в базе десятки.
 *
 *   npx tsx scripts/patients-merge.ts             # показать, ничего не меняя
 *   npx tsx scripts/patients-merge.ts --apply
 *
 * Телефон печатается последними четырьмя цифрами (§7).
 */
import "dotenv/config";
import { prisma } from "../lib/db";

const tail = (phone: string) => `…${phone.slice(-4)}`;

interface Card {
  id: string;
  name: string | null;
  yclientsId: number | null;
  visits: number;
  messages: number;
  purchases: number;
  createdAt: Date;
}

/**
 * Куда склеивать: остаётся карточка с визитами, а при равенстве — старшая.
 *
 * Визиты — это история, ради которой карточка и существует. Переносить их с
 * живой карточки на пустую значит рисковать связями ради ничего.
 */
function keeperOf(cards: Card[]): Card {
  return [...cards].sort(
    (a, b) =>
      b.visits - a.visits ||
      b.messages - a.messages ||
      b.purchases - a.purchases ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  )[0];
}

async function main() {
  const apply = process.argv.includes("--apply");
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

  const phones = await prisma.patientPhone.findMany({
    where: { companyId: company.id, patient: { deletedAt: null } },
    select: { phone: true, patientId: true },
  });

  const byPhone = new Map<string, Set<string>>();
  for (const p of phones) {
    const set = byPhone.get(p.phone) ?? new Set<string>();
    set.add(p.patientId);
    byPhone.set(p.phone, set);
  }

  /**
   * Общий номер связывает карточки в одну группу.
   *
   * У человека номеров бывает несколько, и дубли цепляются по любому из них:
   * карточка А делит номер с Б, Б делит другой номер с В — это один человек.
   */
  const groupOf = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (groupOf.get(root) && groupOf.get(root) !== root) root = groupOf.get(root)!;
    return root;
  };
  for (const ids of byPhone.values()) {
    const list = [...ids];
    if (list.length < 2) continue;
    const root = find(list[0]);
    for (const id of list) groupOf.set(find(id), root);
    groupOf.set(root, root);
  }

  const groups = new Map<string, Set<string>>();
  for (const ids of byPhone.values()) {
    for (const id of ids) {
      if (!groupOf.has(id)) continue;
      const root = find(id);
      const set = groups.get(root) ?? new Set<string>();
      set.add(id);
      groups.set(root, set);
    }
  }

  const duplicates = [...groups.values()].filter((s) => s.size > 1);
  console.log(`клиника: ${company.name}`);
  console.log(`задвоенных карточек: ${duplicates.length} групп\n`);
  if (duplicates.length === 0) return;

  let merged = 0;
  for (const group of duplicates) {
    const rows = await prisma.patient.findMany({
      where: { id: { in: [...group] } },
      select: {
        id: true,
        name: true,
        yclientsId: true,
        createdAt: true,
        _count: {
          select: { appointments: true, conversations: true, coursePurchases: true },
        },
        phones: { select: { phone: true }, take: 1 },
      },
    });
    const cards: Card[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      yclientsId: r.yclientsId,
      visits: r._count.appointments,
      messages: r._count.conversations,
      purchases: r._count.coursePurchases,
      createdAt: r.createdAt,
    }));
    const keeper = keeperOf(cards);
    const others = cards.filter((c) => c.id !== keeper.id);

    console.log(`  ${keeper.name ?? "без имени"} · ${tail(rows[0]?.phones[0]?.phone ?? "")}`);
    console.log(
      `      оставляем: YCLIENTS ${keeper.yclientsId ?? "—"}, визитов ${keeper.visits},` +
        ` диалогов ${keeper.messages}, покупок ${keeper.purchases}`,
    );
    for (const c of others) {
      console.log(
        `      склеиваем: YCLIENTS ${c.yclientsId ?? "—"}, визитов ${c.visits},` +
          ` диалогов ${c.messages}, покупок ${c.purchases}`,
      );
    }

    if (!apply) continue;

    for (const c of others) {
      /**
       * Переносим всё, что держится за карточку, и только потом её убираем.
       *
       * Порядок важен: удалить сначала — значит оборвать связи и потерять
       * визиты, за которыми человек и приходил.
       */
      await prisma.$transaction([
        prisma.appointment.updateMany({ where: { patientId: c.id }, data: { patientId: keeper.id } }),
        prisma.conversation.updateMany({ where: { patientId: c.id }, data: { patientId: keeper.id } }),
        prisma.coursePurchase.updateMany({ where: { patientId: c.id }, data: { patientId: keeper.id } }),
        prisma.course.updateMany({ where: { patientId: c.id }, data: { patientId: keeper.id } }),
        prisma.patientPhone.updateMany({ where: { patientId: c.id }, data: { patientId: keeper.id } }),
        prisma.patientNote.updateMany({ where: { patientId: c.id }, data: { patientId: keeper.id } }),
        // Мягко: карточка пациента исчезнуть насовсем не должна (§4).
        prisma.patient.update({ where: { id: c.id }, data: { deletedAt: new Date() } }),
      ]);
      merged += 1;
    }
  }

  if (!apply) {
    console.log("\nэто предпросмотр. Чтобы склеить: npx tsx scripts/patients-merge.ts --apply");
    console.log("После склейки нужен полный перечёт: npx tsx scripts/yclients-resync.ts --apply");
    return;
  }
  console.log(`\nготово: склеено карточек ${merged}`);
  console.log("Теперь полный перечёт: npx tsx scripts/yclients-resync.ts --apply");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
