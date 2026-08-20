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
 *   npx tsx scripts/patients-merge.ts --apply     # склеить те, что делят номер
 *   npx tsx scripts/patients-merge.ts --apply --name="Багаутдинова Зумруд"
 *
 * Телефон ловит не все дубли. У одной пациентки номер в карточке записан с
 * ошибкой — «+7 796 …», такого кода не бывает, — и общего номера у её двух
 * карточек нет вовсе. Такие пары скрипт показывает отдельно, как подозрение по
 * имени, и склеивает только по прямому указанию: имя ключом не бывает, тёзок в
 * базе десятки, а склейка необратима для истории пациента.
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

/**
 * Подозрение по имени: одинаковое ФИО, но общего телефона нет.
 *
 * Так выглядит дубль, у которого номер записан с ошибкой. Имя ключом не
 * бывает — на «Самира» в базе пять разных людей, — поэтому сами такие пары не
 * склеиваем: показываем и ждём прямого указания.
 */
async function byNameSuspects(companyId: string, apply: boolean): Promise<void> {
  const wanted = process.argv
    .find((a) => a.startsWith("--name="))
    ?.slice("--name=".length)
    .trim();

  const rows = await prisma.patient.findMany({
    where: { companyId, deletedAt: null, NOT: { name: null } },
    select: {
      id: true,
      name: true,
      yclientsId: true,
      createdAt: true,
      _count: { select: { appointments: true, conversations: true, coursePurchases: true } },
      phones: { select: { phone: true } },
    },
  });

  const byName = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = (r.name ?? "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
    if (key.length === 0) continue;
    byName.set(key, [...(byName.get(key) ?? []), r]);
  }

  const suspects = [...byName.entries()].filter(([, list]) => {
    if (list.length < 2) return false;
    // Общий номер уже разобран выше — здесь только те, у кого его нет.
    const phones = list.flatMap((r) => r.phones.map((p) => p.phone));
    return new Set(phones).size === phones.length;
  });

  if (suspects.length === 0) return;
  console.log(`\n── одинаковое имя, но телефоны разные: ${suspects.length} ──`);
  console.log("   это может быть и дубль с ошибкой в номере, и просто тёзки\n");
  for (const [key, list] of suspects) {
    console.log(`  «${list[0].name}»`);
    for (const r of list) {
      console.log(
        `      ${tail(r.phones[0]?.phone ?? "")} · YCLIENTS ${r.yclientsId ?? "—"}` +
          ` · визитов ${r._count.appointments} · диалогов ${r._count.conversations}`,
      );
    }
    if (!apply || !wanted || wanted.toLowerCase() !== key) {
      console.log(`      склеить: --apply --name="${list[0].name}"`);
      continue;
    }

    const cards: Card[] = list.map((r) => ({
      id: r.id,
      name: r.name,
      yclientsId: r.yclientsId,
      visits: r._count.appointments,
      messages: r._count.conversations,
      purchases: r._count.coursePurchases,
      createdAt: r.createdAt,
    }));
    const keeper = keeperOf(cards);
    for (const c of cards.filter((x) => x.id !== keeper.id)) {
      await mergeInto(keeper.id, c.id);
      console.log(`      склеено: YCLIENTS ${c.yclientsId ?? "—"} → ${keeper.yclientsId ?? "—"}`);
    }
  }
}

/** Перенести всё с одной карточки на другую и мягко удалить пустую. */
async function mergeInto(keeperId: string, otherId: string): Promise<void> {
  await prisma.$transaction([
    prisma.appointment.updateMany({ where: { patientId: otherId }, data: { patientId: keeperId } }),
    prisma.conversation.updateMany({ where: { patientId: otherId }, data: { patientId: keeperId } }),
    prisma.coursePurchase.updateMany({ where: { patientId: otherId }, data: { patientId: keeperId } }),
    prisma.course.updateMany({ where: { patientId: otherId }, data: { patientId: keeperId } }),
    prisma.patientPhone.updateMany({ where: { patientId: otherId }, data: { patientId: keeperId } }),
    prisma.patientNote.updateMany({ where: { patientId: otherId }, data: { patientId: keeperId } }),
    // Мягко: карточка пациента исчезнуть насовсем не должна (§4).
    prisma.patient.update({ where: { id: otherId }, data: { deletedAt: new Date() } }),
  ]);
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
      // Переносим всё, что держится за карточку, и только потом её убираем:
      // удалить сначала — значит оборвать связи и потерять визиты.
      await mergeInto(keeper.id, c.id);
      merged += 1;
    }
  }

  await byNameSuspects(company.id, apply);

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
