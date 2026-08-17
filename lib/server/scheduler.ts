import { prisma } from "@/lib/db";
import { syncAll } from "@/lib/integrations/yclients/sync";
import { backfillFirstSeen, backfillRooms, recomputeVisitKinds } from "@/lib/metrics/recompute";
import { answerUnanswered } from "@/lib/agent/unanswered";

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
}

const shared: SchedulerShared = ((globalThis as Record<string, unknown>).__clinicScheduler ??= {
  history: [],
  running: false,
  timer: null,
  startedAt: null,
}) as SchedulerShared;

export function schedulerState() {
  return {
    включён: shared.timer !== null,
    интервалМинут: INTERVAL_MIN,
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
}
