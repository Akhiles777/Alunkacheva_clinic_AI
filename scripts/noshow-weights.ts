/**
 * Подобрать веса прогноза неявки по истории КЛИНИКИ.
 *
 * Веса нельзя взять с потолка: «первичные не приходят чаще» — общее место, а
 * в конкретной клинике это может быть неверно. Скрипт считает, насколько
 * каждый признак связан с неявкой в её собственных данных, и предлагает веса.
 * Утверждает их человек — до утверждения прогноз не показывается вовсе.
 *
 *   npx tsx scripts/noshow-weights.ts             # посчитать и показать
 *   npx tsx scripts/noshow-weights.ts --apply     # записать в настройки
 *
 * Как считается. Для каждого разобранного визита за последний год смотрим,
 * был ли у него признак, и сравниваем долю неявок с признаком и без него.
 * Разница долей (её называют «подъёмом») и есть вес: признак, который поднимает
 * неявки на 20 пунктов, весит вдвое больше того, что поднимает на 10.
 *
 * Признак, встретившийся меньше 20 раз, вес не получает: на пяти случаях
 * разница долей — шум, а не знание. Такой вес остаётся нулевым, и это честнее
 * выдуманного числа.
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { startOfClinicDay, clinicMinuteOfDay } from "../lib/clinic-time";
import { FAR_HORIZON_DAYS, MIN_SLOT_VISITS, type NoShowWeights } from "../lib/metrics/no-show";
import { saveWeights } from "../lib/server/no-show";

/** За какой срок берём историю. */
const DAYS = 365;
/** Меньше этого числа наблюдений — признак в веса не идёт. */
const MIN_CASES = 20;

interface Case {
  missed: boolean;
  history: number | null;
  farHorizon: boolean;
  firstVisit: boolean;
  slotRate: number | null;
  course: boolean;
}

function lift(cases: Case[], has: (c: Case) => boolean): { lift: number; n: number; rate: number; base: number } {
  const withIt = cases.filter(has);
  const without = cases.filter((c) => !has(c));
  if (withIt.length === 0 || without.length === 0) return { lift: 0, n: withIt.length, rate: 0, base: 0 };
  const rate = withIt.filter((c) => c.missed).length / withIt.length;
  const base = without.filter((c) => c.missed).length / without.length;
  return { lift: rate - base, n: withIt.length, rate, base };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const company = await prisma.company.findFirstOrThrow({
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
  console.log(`клиника: ${company.name}`);

  const from = new Date(Date.now() - DAYS * 24 * 3600 * 1000);
  const appts = await prisma.appointment.findMany({
    where: {
      companyId: company.id,
      deletedAt: null,
      startAt: { gte: from },
      status: { in: ["ARRIVED", "NO_SHOW"] },
    },
    select: {
      patientId: true,
      startAt: true,
      status: true,
      createdAtYclients: true,
      courseId: true,
    },
    orderBy: { startAt: "asc" },
  });

  console.log(`разобранных визитов за ${DAYS} дней: ${appts.length}`);
  if (appts.length < 50) {
    console.log("Мало данных: на такой истории веса были бы шумом. Функцию пока не включаем.");
    return;
  }

  /** Доля неявок по слоту — та же, что в прогнозе. */
  const slotAcc = new Map<string, { missed: number; total: number }>();
  const slotKey = (at: Date) => {
    const hour = Math.floor(clinicMinuteOfDay(at) / 60);
    const weekday = new Date(at.getTime() + 3 * 3600 * 1000).getUTCDay();
    return `${weekday}-${hour}`;
  };
  for (const a of appts) {
    const key = slotKey(a.startAt);
    const cur = slotAcc.get(key) ?? { missed: 0, total: 0 };
    cur.total += 1;
    if (a.status === "NO_SHOW") cur.missed += 1;
    slotAcc.set(key, cur);
  }

  /**
   * История пациента считается НА МОМЕНТ визита, а не на сегодня: иначе
   * признак знал бы будущее и выглядел бы сильнее, чем он есть.
   */
  const seen = new Map<string, { came: number; missed: number }>();
  const cases: Case[] = [];
  for (const a of appts) {
    const prior = seen.get(a.patientId) ?? { came: 0, missed: 0 };
    const priorTotal = prior.came + prior.missed;
    const slot = slotAcc.get(slotKey(a.startAt));
    const horizon = a.createdAtYclients
      ? Math.round(
          (startOfClinicDay(a.startAt).getTime() - startOfClinicDay(a.createdAtYclients).getTime()) /
            (24 * 3600 * 1000),
        )
      : null;

    cases.push({
      missed: a.status === "NO_SHOW",
      history: priorTotal >= 3 ? prior.missed / priorTotal : null,
      farHorizon: horizon !== null && horizon >= FAR_HORIZON_DAYS,
      firstVisit: prior.came === 0,
      slotRate: slot && slot.total >= MIN_SLOT_VISITS ? slot.missed / slot.total : null,
      course: a.courseId !== null,
    });

    if (a.status === "NO_SHOW") prior.missed += 1;
    else prior.came += 1;
    seen.set(a.patientId, prior);
  }

  const overall = cases.filter((c) => c.missed).length / cases.length;
  console.log(`неявок всего: ${pct(overall)}\n`);

  const signals: { key: keyof NoShowWeights; label: string; has: (c: Case) => boolean }[] = [
    { key: "history", label: "уже не приходил раньше", has: (c) => (c.history ?? 0) > 0 },
    { key: "horizon", label: `записан за ${FAR_HORIZON_DAYS}+ дней`, has: (c) => c.farHorizon },
    { key: "firstVisit", label: "первый визит", has: (c) => c.firstVisit },
    { key: "slot", label: "плохой слот (день и час)", has: (c) => (c.slotRate ?? 0) > overall },
    { key: "courseOverdue", label: "сеанс курса", has: (c) => c.course },
  ];

  const weights: NoShowWeights = {
    history: 0,
    horizon: 0,
    firstVisit: 0,
    unconfirmed: 0,
    slot: 0,
    courseOverdue: 0,
    moved: 0,
    threshold: 0,
  };

  console.log("признак                        случаев   неявки   без признака   подъём   вес");
  for (const s of signals) {
    const r = lift(cases, s.has);
    const enough = r.n >= MIN_CASES;
    /** Вес — подъём в долях: 0,2 подъёма даёт вес 0,2. Отрицательный — ноль. */
    const weight = enough ? Math.max(0, Math.round(r.lift * 100) / 100) : 0;
    (weights[s.key] as number) = weight;
    console.log(
      `${s.label.padEnd(30)} ${String(r.n).padStart(6)}   ${pct(r.rate).padStart(6)}   ${pct(
        r.base,
      ).padStart(12)}   ${(r.lift >= 0 ? "+" : "") + pct(r.lift).padStart(6)}   ${
        enough ? weight.toFixed(2) : "мало данных"
      }`,
    );
  }

  /**
   * «Не ответил на сообщение» и «переносили» по истории не проверить: в базе
   * не сохранилось, отвечал ли пациент ДО того визита, а перенос YCLIENTS
   * делает пересозданием записи. Оставляем нули — признак есть в коде, но
   * веса у него нет, пока его нельзя измерить.
   */
  console.log("\nне ответил на сообщение        — по истории не проверяется, вес 0");
  console.log("запись переносили              — в базе не сохраняется, вес 0");

  /**
   * Порог — половина суммы весов: пометку получают записи, у которых
   * сработала примерно половина того, что вообще может сработать. Это
   * отправная точка, её видно на экране качества и можно поднять.
   */
  const sum = weights.history + weights.horizon + weights.firstVisit + weights.slot + weights.courseOverdue;
  weights.threshold = Math.round((sum / 2) * 100) / 100;

  console.log(`\nПРЕДЛАГАЕМЫЕ ВЕСА:`);
  console.log(JSON.stringify(weights, null, 2));
  console.log(
    `\nПорог ${weights.threshold}: пометку получит запись, у которой сработала примерно половина признаков.`,
  );

  if (!apply) {
    console.log("\nсухой прогон: в настройки ничего не записано");
    console.log("утвердить: npx tsx scripts/noshow-weights.ts --apply");
    return;
  }
  if (sum === 0) {
    console.log("\nВсе веса нулевые — включать нечего. Настройки не тронуты.");
    return;
  }
  await saveWeights(company.id, weights);
  console.log("\nвеса записаны в настройки клиники, прогноз включён");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
