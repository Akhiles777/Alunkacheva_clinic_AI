/**
 * Привязка услуг и специалистов к кабинетам — предложение, а не догадка.
 *
 * Кабинеты в YCLIENTS как ресурсы не заведены, поэтому в записях их нет вовсе.
 * Привязка задаётся у нас: у специалиста (кабинет по умолчанию) или у услуги.
 * Пока она пуста, все визиты остаются без кабинета — и загрузка кабинетов в
 * отчётах нулевая при полной базе визитов. Именно это сейчас и происходит:
 * 4900 визитов, ни одного с кабинетом.
 *
 * Заполнить руками — три десятка кликов и знание, кто где принимает. Скрипт
 * предлагает вариант по названиям: «Кабинет БОС-терапии» ↔ услуга «БОС-терапия»,
 * «Кабинет остеопата» ↔ специальность «остеопат». Совпадение по словам — это
 * подсказка, а не истина, поэтому по умолчанию скрипт только печатает
 * предложение. Применяет с --apply, и только то, что не задано.
 *
 *   npx tsx scripts/rooms-suggest.ts
 *   npx tsx scripts/rooms-suggest.ts --apply
 */
import "dotenv/config";
import { prisma } from "../lib/db";

/** Значимые слова названия: «Кабинет 2 — БОС-терапии» → ["бос", "терапии"]. */
function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w.length > 3 && !["кабинет", "прием", "приём"].includes(w));
}

/** Насколько название похоже на название кабинета: доля общих слов. */
function score(a: string, b: string): number {
  const wa = new Set(words(a));
  const wb = new Set(words(b));
  if (wa.size === 0 || wb.size === 0) return 0;

  let common = 0;
  for (const w of wb) {
    // Совпадением считаем и общий корень: «остеопат» ↔ «остеопатия».
    if ([...wa].some((x) => x.startsWith(w.slice(0, 5)) || w.startsWith(x.slice(0, 5)))) common += 1;
  }
  return common / Math.min(wa.size, wb.size);
}

/**
 * Кабинет по виду услуги.
 *
 * Совпадения по названию мало: «Нейрококтейль», «Антистресс коктейль» и
 * «Забор анализов» с «Кабинетом 1 — процедурный» не пересекаются ни одним
 * словом, а идут именно там. Вид услуги знает об этом прямо: капельницы и
 * анализы — процедурный кабинет.
 */
const ROOM_WORD_BY_KIND: Record<string, string> = {
  OSTEOPATHY: "остеопат",
  BIOFEEDBACK: "бос",
  NEUROMEDITATION: "нейромед",
  IV_THERAPY: "процедур",
  LAB: "процедур",
};

function roomByKind(kind: string, rooms: { id: string; name: string }[]): { id: string; name: string } | null {
  const word = ROOM_WORD_BY_KIND[kind];
  if (!word) return null;
  const matched = rooms.filter((r) => r.name.toLowerCase().replace(/ё/g, "е").includes(word));
  // Подошёл ровно один — привязываем; несколько или ни одного — не гадаем.
  return matched.length === 1 ? matched[0] : null;
}

/** Кабинет с лучшим совпадением, если оно уверенное. */
function bestRoom(name: string, rooms: { id: string; name: string }[]): { id: string; name: string } | null {
  const ranked = rooms
    .map((room) => ({ room, value: score(room.name, name) }))
    .sort((a, b) => b.value - a.value);
  const top = ranked[0];
  if (!top || top.value < 0.5) return null;
  // Два кабинета подошли одинаково — выбирать нельзя.
  if (ranked[1] && ranked[1].value === top.value) return null;
  return top.room;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

  const [rooms, staff, services, withRoom, withoutRoom] = await Promise.all([
    prisma.room.findMany({
      where: { companyId: company.id, isActive: true },
      select: { id: true, name: true },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.staff.findMany({
      where: { companyId: company.id, isActive: true, deletedAt: null },
      select: { id: true, name: true, specialty: true, defaultRoomId: true },
    }),
    prisma.service.findMany({
      where: { companyId: company.id },
      select: { id: true, title: true, kind: true, rooms: { select: { roomId: true } } },
    }),
    prisma.appointment.count({ where: { companyId: company.id, deletedAt: null, roomId: { not: null } } }),
    prisma.appointment.count({ where: { companyId: company.id, deletedAt: null, roomId: null } }),
  ]);

  console.log(`клиника: ${company.name}`);
  console.log(`кабинетов: ${rooms.length}; визитов с кабинетом: ${withRoom}, без кабинета: ${withoutRoom}`);
  if (rooms.length === 0) {
    console.log("кабинеты не заведены — сначала «Настройки → Кабинеты»");
    await prisma.$disconnect();
    return;
  }
  console.log(`\nкабинеты: ${rooms.map((r) => r.name).join(" | ")}`);

  // ── Специалисты
  console.log(`\n═══ СПЕЦИАЛИСТЫ ═══`);
  const staffPlan: { id: string; roomId: string; label: string }[] = [];
  for (const s of staff) {
    if (s.defaultRoomId) {
      console.log(`  ${s.name.padEnd(28)} уже задан`);
      continue;
    }
    const match = bestRoom(`${s.specialty ?? ""} ${s.name}`, rooms);
    if (!match) {
      console.log(`  ${s.name.padEnd(28)} ${(s.specialty ?? "—").padEnd(24)} совпадения нет`);
      continue;
    }
    console.log(`  ${s.name.padEnd(28)} ${(s.specialty ?? "—").padEnd(24)} → ${match.name}`);
    staffPlan.push({ id: s.id, roomId: match.id, label: s.name });
  }

  // ── Услуги
  console.log(`\n═══ УСЛУГИ ═══`);
  const servicePlan: { id: string; roomId: string; label: string }[] = [];
  for (const s of services) {
    if (s.rooms.length > 0) {
      console.log(`  ${s.title.slice(0, 34).padEnd(36)} уже задана`);
      continue;
    }
    // Сначала по названию, затем по виду услуги: «Нейрококтейль» с
    // «процедурным» не пересекается ни одним словом, но идёт именно там.
    const match = bestRoom(s.title, rooms) ?? roomByKind(s.kind, rooms);
    if (!match) {
      console.log(`  ${s.title.slice(0, 34).padEnd(36)} ${String(s.kind).padEnd(16)} совпадения нет`);
      continue;
    }
    console.log(`  ${s.title.slice(0, 34).padEnd(36)} ${String(s.kind).padEnd(16)} → ${match.name}`);
    servicePlan.push({ id: s.id, roomId: match.id, label: s.title });
  }

  console.log(
    `\nпредложено: специалистов ${staffPlan.length}, услуг ${servicePlan.length}. ` +
      `Остальное совпадением не определяется — задайте руками в настройках.`,
  );

  if (!apply) {
    console.log("\nэто предварительный просмотр. чтобы применить: --apply");
    await prisma.$disconnect();
    return;
  }

  for (const p of staffPlan) {
    await prisma.staff.update({ where: { id: p.id }, data: { defaultRoomId: p.roomId } });
  }
  for (const p of servicePlan) {
    await prisma.serviceRoom
      .create({ data: { companyId: company.id, serviceId: p.id, roomId: p.roomId } })
      .catch(() => {});
  }
  console.log(`\nприменено. Чтобы кабинеты проставились уже существующим визитам:`);
  console.log(`  npx tsx scripts/yclients-resync.ts --apply`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("не удалось:", e);
  await prisma.$disconnect();
  process.exit(1);
});
