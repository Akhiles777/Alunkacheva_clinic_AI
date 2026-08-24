import { prisma } from "@/lib/db";
import {
  syncAll,
  syncRecentRecords,
  RECENT_BACK_DAYS,
  RECENT_FORWARD_DAYS,
} from "@/lib/integrations/yclients/sync";
import { backfillFirstSeen, backfillRooms, recomputeVisitKinds } from "@/lib/metrics/recompute";
import { answerUnanswered } from "@/lib/agent/unanswered";
import { handBackAndRemind } from "@/lib/agent/handback";

/**
 * Синхронизация с YCLIENTS по расписанию — внутри приложения.
 *
 * Сначала это делал системный cron. На практике он оказался ненадёжным
 * посредником: строку вставили не туда, потом она задвоилась, потом перестала
 * срабатывать — и всё это время никто не знал, идут ли данные, потому что cron
 * пишет о своих неудачах в почту, которую на сервере никто не читает.
 *
 * Приложение под pm2 живёт постоянно, поэтому пусть считает время само. Плюсы
 * ровно два, но решающие: не нужно ничего настраивать на сервере, и состояние
 * видно через тот же адрес, что и данные (/api/cron/sync?check=1).
 *
 * Ручной запуск через адрес остаётся: он нужен, когда ждать очередного круга
 * некогда.
 */

/** Как часто синхронизируемся. Пятнадцать минут — компромисс между свежестью
 * отметок «пришёл» и лимитом запросов YCLIENTS: один круг это около сорока
 * секунд и порядка сотни запросов. */
const INTERVAL_MIN = Number(process.env.SYNC_INTERVAL_MIN ?? 15);

/**
 * Короткий круг — только свежие записи, каждые три минуты.
 *
 * Вебхуков от YCLIENTS нет: в настройках клиники места для нашего адреса не
 * нашлось. Значит про новую запись и про отметку «пришёл» мы узнаём только
 * тогда, когда спросим. Полный круг чаще чем раз в четверть часа гонять
 * нельзя — он перечитывает справочник клиентов, кассу за двести дней и месяц
 * истории по кругу. Короткий спрашивает два-три раза и стоит секунды.
 *
 * Тем же кругом идут возврат диалогов агенту и добор неотвеченных: пациент,
 * чьё сообщение потерялось, ждал ответа до четверти часа, теперь — минуты.
 */
const FAST_INTERVAL_MIN = Number(process.env.SYNC_FAST_INTERVAL_MIN ?? 3);

/** Первый прогон — не в момент старта: дадим приложению подняться. */
const FIRST_RUN_DELAY_MS = 60_000;

export interface SyncRunInfo {
  startedAt: string;
  finishedAt: string | null;
  ok: boolean;
  ms: number | null;
  counts?: unknown;
  error?: string;
}

/**
 * Состояние расписания — в globalThis, а не в переменных модуля.
 *
 * Next.js собирает instrumentation.ts и обработчики адресов в разные пачки:
 * модуль загружается дважды, и у каждой копии свои переменные. Из-за этого
 * экран состояния честно показывал «расписание выключено» при работающем
 * расписании — притом что выгрузка в это же время шла. Такое расхождение хуже
 * отсутствия показателя: ему верят и начинают чинить исправное.
 *
 * globalThis один на процесс, поэтому обе копии видят одно и то же.
 */
interface SchedulerShared {
  history: SyncRunInfo[];
  running: boolean;
  timer: NodeJS.Timeout | null;
  startedAt: Date | null;
  /** Короткий круг: свой таймер и свой замок, но общий с полным кругом флаг. */
  fastTimer: NodeJS.Timeout | null;
  fastRunning: boolean;
  fastHistory: SyncRunInfo[];
}

const shared: SchedulerShared = ((globalThis as Record<string, unknown>).__clinicScheduler ??= {
  history: [],
  running: false,
  timer: null,
  startedAt: null,
  fastTimer: null,
  fastRunning: false,
  fastHistory: [],
}) as SchedulerShared;

export function schedulerState() {
  return {
    включён: shared.timer !== null,
    // Идёт первый круг — это не «не проходил ни одного»: на экране такая
    // подпись читалась как «расписание не работает» при работающем расписании.
    первыйКругИдёт: shared.running && shared.history.length === 0,
    интервалМинут: INTERVAL_MIN,
    короткийКруг: {
      интервалМинут: FAST_INTERVAL_MIN,
      включён: shared.fastTimer !== null,
      окноДней: { назад: RECENT_BACK_DAYS, вперёд: RECENT_FORWARD_DAYS },
      идётСейчас: shared.fastRunning,
      последниеПрогоны: shared.fastHistory.slice(-5),
    },
    работаетСо: shared.startedAt?.toISOString() ?? null,
    идётСейчас: shared.running,
    последниеПрогоны: shared.history.slice(-5),
  };
}

/**
 * Один круг: выгрузка и пересчёт производных полей.
 *
 * Пересчёт обязателен здесь же: первичность визита зависит от всей истории
 * пациента, и без него отчёты показывают прежние значения при новых данных.
 */
export async function runSyncCycle(): Promise<SyncRunInfo> {
  if (shared.running) {
    return { startedAt: new Date().toISOString(), finishedAt: null, ok: false, ms: null, error: "уже идёт" };
  }

  /**
   * Дожидаемся короткого круга, а не отменяем свой.
   *
   * Полный круг проверял только собственный замок: короткий мог идти в это же
   * время, и оба писали бы одни и те же записи и пересчитывали одно и то же.
   * Пропускать полный круг из-за трёхсекундного короткого нельзя — он ходит
   * раз в четверть часа, и пропуск стоит дороже ожидания. Поэтому ждём, но не
   * бесконечно: если короткий завис, полный всё равно пойдёт, а параллельная
   * запись здесь идемпотентна (всё по уникальным номерам YCLIENTS).
   */
  const waitUntil = Date.now() + 60_000;
  while (shared.fastRunning && Date.now() < waitUntil) {
    await new Promise((r) => setTimeout(r, 500));
  }

  shared.running = true;
  const started = Date.now();
  const info: SyncRunInfo = {
    startedAt: new Date(started).toISOString(),
    finishedAt: null,
    ok: false,
    ms: null,
  };

  try {
    const companies = await prisma.company.findMany({
      // Временные номера из начальных данных лежат ниже ста: с ними
      // синхронизировать нечего.
      where: { yclientsId: { gte: 100 } },
      select: { id: true, name: true },
    });

    const results: unknown[] = [];
    for (const company of companies) {
      const counts = await syncAll(company.id);
      const [kinds, rooms, firstSeen] = await Promise.all([
        recomputeVisitKinds(company.id),
        backfillRooms(company.id),
        backfillFirstSeen(company.id),
      ]);
      /**
       * Добор неотвеченных — здесь же, каждым кругом.
       *
       * Пациенту приходилось писать дважды: первое сообщение оставалось без
       * ответа. Причины разные — провайдер не принял отправку, модель ответила
       * ошибкой, обработка упала. Проверяем результат, а не причины.
       */
      /**
       * Диалоги, которые ведёт человек: вернуть агенту через сутки тишины и
       * напомнить о тех, где пациент ждёт больше получаса.
       *
       * До добора неотвеченных: диалог, вернувшийся агенту, тем же кругом
       * получит ответ, а не следующим через пятнадцать минут.
       */
      const handback = await handBackAndRemind(company.id).catch((e) => {
        console.error("[scheduler] возврат диалогов не удался:", (e as Error)?.message ?? e);
        return null;
      });

      const sweep = await answerUnanswered(company.id).catch((e) => {
        console.error("[scheduler] добор не удался:", (e as Error)?.message ?? e);
        return null;
      });

      results.push({
        клиника: company.name,
        counts,
        пересчитано: kinds.updated,
        кабинетовПроставлено: rooms,
        датПервогоОбращения: firstSeen,
        возвратДиалогов: handback,
        доборНеотвеченных: sweep,
      });
    }

    info.ok = true;
    info.counts = results;
  } catch (e) {
    // Одна неудача не должна останавливать расписание: следующий круг пойдёт
    // как обычно, а причина видна на экране состояния.
    info.error = String((e as Error)?.message ?? e).slice(0, 300);
    console.error("[scheduler] выгрузка не удалась:", info.error);
  } finally {
    shared.running = false;
    info.finishedAt = new Date().toISOString();
    info.ms = Date.now() - started;
    shared.history.push(info);
    if (shared.history.length > 20) shared.history.shift();
  }

  return info;
}

/**
 * Короткий круг: свежие записи, возврат диалогов и добор неотвеченных.
 *
 * Пропускается, пока идёт полный круг: спрашивать YCLIENTS про те же дни
 * дважды одновременно незачем, а два пересчёта разом только мешают друг другу.
 */
export async function runFastCycle(): Promise<SyncRunInfo> {
  const started = Date.now();
  const info: SyncRunInfo = {
    startedAt: new Date(started).toISOString(),
    finishedAt: null,
    ok: false,
    ms: null,
  };
  if (shared.running || shared.fastRunning) {
    info.error = shared.running ? "идёт полный круг" : "уже идёт";
    info.finishedAt = new Date().toISOString();
    info.ms = 0;
    return info;
  }
  shared.fastRunning = true;

  try {
    const companies = await prisma.company.findMany({
      where: { yclientsId: { gte: 100 } },
      select: { id: true, name: true },
    });

    const results: unknown[] = [];
    for (const company of companies) {
      const sync = await syncRecentRecords(company.id);

      /**
       * Пересчёт — только по пациентам этого окна.
       *
       * Первичность визита зависит от всей истории пациента, поэтому история
       * читается целиком, но перебирать ради двух дней всю базу незачем: это
       * и есть та цена, из-за которой полный круг нельзя гонять часто.
       */
      const touched = await prisma.appointment.findMany({
        where: {
          companyId: company.id,
          deletedAt: null,
          startAt: {
            gte: new Date(Date.now() - RECENT_BACK_DAYS * 24 * 3600 * 1000),
            lte: new Date(Date.now() + RECENT_FORWARD_DAYS * 24 * 3600 * 1000),
          },
        },
        select: { patientId: true },
        distinct: ["patientId"],
      });
      const kinds = await recomputeVisitKinds(
        company.id,
        touched.map((t) => t.patientId).filter((id): id is string => Boolean(id)),
      );

      const handback = await handBackAndRemind(company.id).catch((e) => {
        console.error("[scheduler] возврат диалогов не удался:", (e as Error)?.message ?? e);
        return null;
      });
      const sweep = await answerUnanswered(company.id).catch((e) => {
        console.error("[scheduler] добор не удался:", (e as Error)?.message ?? e);
        return null;
      });

      results.push({
        клиника: company.name,
        записей: sync.records,
        пересчитано: kinds.updated,
        возвратДиалогов: handback,
        доборНеотвеченных: sweep,
      });
    }
    info.ok = true;
    info.counts = results;
  } catch (e) {
    info.error = String((e as Error)?.message ?? e).slice(0, 300);
    console.error("[scheduler] короткий круг не удался:", info.error);
  } finally {
    shared.fastRunning = false;
    info.finishedAt = new Date().toISOString();
    info.ms = Date.now() - started;
    shared.fastHistory.push(info);
    if (shared.fastHistory.length > 20) shared.fastHistory.shift();
  }
  return info;
}

/**
 * Запустить расписание. Вызывается один раз при старте процесса из
 * instrumentation.ts; повторный вызов ничего не делает.
 */
export function startScheduler(): void {
  if (shared.timer) return;
  if (INTERVAL_MIN <= 0) {
    console.warn("[scheduler] SYNC_INTERVAL_MIN <= 0 — синхронизация по расписанию выключена");
    return;
  }

  shared.startedAt = new Date();
  shared.timer = setInterval(() => void runSyncCycle(), INTERVAL_MIN * 60_000);
  // Таймер не должен держать процесс живым сам по себе — этим занимается сервер.
  shared.timer.unref?.();

  setTimeout(() => void runSyncCycle(), FIRST_RUN_DELAY_MS).unref?.();
  console.log(`[scheduler] синхронизация с YCLIENTS каждые ${INTERVAL_MIN} мин`);

  if (FAST_INTERVAL_MIN > 0 && FAST_INTERVAL_MIN < INTERVAL_MIN) {
    shared.fastTimer = setInterval(() => void runFastCycle(), FAST_INTERVAL_MIN * 60_000);
    shared.fastTimer.unref?.();
    console.log(`[scheduler] короткий круг каждые ${FAST_INTERVAL_MIN} мин`);
  } else {
    /**
     * Молчать нельзя: выключенный короткий круг выглядит точно так же, как
     * работающий, — данные всё равно идут, просто медленнее. Причину называем
     * сразу, иначе её будут искать в коде.
     */
    console.warn(
      `[scheduler] короткий круг выключен: SYNC_FAST_INTERVAL_MIN=${FAST_INTERVAL_MIN} ` +
        `при SYNC_INTERVAL_MIN=${INTERVAL_MIN} (нужно значение больше нуля и меньше полного круга)`,
    );
  }
}
