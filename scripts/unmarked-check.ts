/**
 * Приёмы без отметки: перенос или забыли проставить.
 *
 * Вопрос заказчика был прямой: «мне кажется, эти два неотмеченных — те, кто
 * перенёс запись, а может, админ просто забыл». Гадать тут нельзя: действия
 * разные — позвонить человеку или попросить проставить отметку.
 *
 * Разбирает каждый приём по отдельности и говорит, на чём основан вывод.
 * Ничего не меняет — только читает.
 *
 *   npx tsx scripts/unmarked-check.ts             # за сегодня
 *   npx tsx scripts/unmarked-check.ts 2026-09-11
 *   npx tsx scripts/unmarked-check.ts --days=7    # за неделю назад
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { clinicDateKey, clinicDayRange } from "../lib/clinic-time";
import {
  explainUnmarked,
  MOVE_GRACE_MIN,
  UNMARKED_LABEL,
  type KnownMove,
  type OtherBooking,
} from "../lib/metrics/unmarked";

const WHEN = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});

async function analyseDay(companyId: string, dayKey: string, now: Date): Promise<number> {
  const { start: from, end: to } = clinicDayRange(new Date(`${dayKey}T12:00:00Z`));

  const [planned, moves] = await Promise.all([
    prisma.appointment.findMany({
      where: {
        companyId,
        deletedAt: null,
        status: { in: ["CREATED", "CONFIRMED"] },
        startAt: { gte: from, lt: to },
      },
      orderBy: { startAt: "asc" },
      select: {
        id: true,
        patientId: true,
        startAt: true,
        endAt: true,
        yclientsRecordId: true,
        patient: { select: { name: true } },
        staff: { select: { name: true } },
      },
    }),
    prisma.appointmentMove.findMany({
      where: { companyId, fromStartAt: { gte: from, lt: to } },
      select: { fromStartAt: true, toStartAt: true, exact: true },
    }),
  ]);

  /** Прошедшие — те, чьё время закончилось. Идущий приём отметки и не ждёт. */
  const over = planned.filter((p) => p.endAt <= now);
  if (over.length === 0) {
    console.log(`  ${dayKey}: неотмеченных нет`);
    return 0;
  }

  const patientIds = [...new Set(over.map((p) => p.patientId).filter(Boolean))] as string[];
  const others = patientIds.length
    ? await prisma.appointment.findMany({
        where: {
          companyId,
          deletedAt: null,
          patientId: { in: patientIds },
          status: { notIn: ["CANCELLED"] },
          createdAtYclients: { gte: from },
        },
        select: { id: true, patientId: true, startAt: true, createdAtYclients: true },
      })
    : [];

  const known: KnownMove[] = moves.map((m) => ({
    fromStartAt: m.fromStartAt,
    toStartAt: m.toStartAt,
    exact: m.exact,
  }));

  console.log(`\n  ── ${dayKey}: без отметки ${over.length}`);
  for (const p of over) {
    const mine: OtherBooking[] = others
      .filter((o) => o.patientId === p.patientId && o.id !== p.id)
      .map((o) => ({
        appointmentId: o.id,
        startAt: o.startAt,
        createdAt: o.createdAtYclients ?? o.startAt,
      }));

    const v = explainUnmarked(
      { appointmentId: p.id, patientId: p.patientId, startAt: p.startAt, endedAt: p.endAt },
      known,
      mine,
      now,
    );
    const who = p.patient?.name?.trim() || "без имени";
    const waited = Math.round((now.getTime() - p.endAt.getTime()) / 60_000);
    console.log(
      `  ${WHEN.format(p.startAt)}  ${who.padEnd(28)} ${UNMARKED_LABEL[v.kind].padEnd(18)} ` +
        `(висит ${waited} мин, запись ${p.yclientsRecordId ?? "—"})`,
    );
    console.log(`      ${v.reason}${v.movedTo ? ` → ${WHEN.format(v.movedTo)}` : ""}`);
    if (mine.length > 0) {
      for (const o of mine.slice(0, 3)) {
        console.log(
          `      другая запись: ${WHEN.format(o.startAt)}, заведена ${WHEN.format(o.createdAt)}`,
        );
      }
    }
  }
  return over.length;
}

async function main() {
  const dayArg = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const daysArg = process.argv.find((a) => a.startsWith("--days="));
  const days = daysArg ? Math.max(1, Math.min(60, Number(daysArg.slice(7)) || 1)) : 1;

  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const now = new Date();
  console.log(`клиника: ${company.name}`);
  console.log(
    `правило: перенос правкой уходит за 3 мин, пересозданием — за 15 (полный круг).\n` +
      `        строка без следов переноса старше ${MOVE_GRACE_MIN} мин — непроставленная отметка.\n`,
  );

  const keys: string[] = [];
  if (dayArg) keys.push(dayArg);
  else {
    for (let back = 0; back < days; back += 1) {
      keys.push(clinicDateKey(new Date(now.getTime() - back * 24 * 3600 * 1000)));
    }
  }

  let total = 0;
  for (const key of keys) total += await analyseDay(company.id, key, now);

  console.log(`\nвсего неотмеченных: ${total}`);

  /**
   * Отдельно — сколько переносов вообще записано. Ноль здесь означает не
   * «не переносят», а «учёт переносов начался позже»: YCLIENTS о переносах не
   * сообщает, и замечает их только выгрузка с момента выкатки.
   */
  const [movesAll, firstMove] = await Promise.all([
    prisma.appointmentMove.count({ where: { companyId: company.id } }),
    prisma.appointmentMove.findFirst({
      where: { companyId: company.id },
      orderBy: { detectedAt: "asc" },
      select: { detectedAt: true },
    }),
  ]);
  console.log(
    movesAll === 0
      ? "переносов не записано ни одного — учёт начинается с выкатки, про прошлое мы честно не знаем"
      : `переносов записано: ${movesAll}, счёт ведётся с ${WHEN.format(firstMove!.detectedAt)}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
