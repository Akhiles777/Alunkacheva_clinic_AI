import { prisma } from "@/lib/db";

/**
 * Перезапуски приложения и память процесса.
 *
 * Появилось из жалобы «платформа иногда слетает». Механизм такой: pm2 следит
 * за памятью и по достижении предела (`max_memory_restart` в
 * `ecosystem.config.cjs`) убивает процесс. Делает он это МОЛЧА — ни в
 * интерфейсе, ни в журнале приложения следа не остаётся. Со стороны человека
 * это выглядит так: несколько секунд платформа не отвечает, service worker
 * подменяет страницу офлайн-заглушкой, набранное пропадает. То есть «слетает»
 * и «перебрасывает» — один и тот же случай, а не два разных.
 *
 * Пока перезапуски не записывались, отличить их от перебоя связи было нечем, и
 * предел памяти подбирали бы наугад. Здесь одна строка на запуск процесса —
 * этого хватает, чтобы ответить числом: сколько раз за сутки и с какой памяти.
 */

/** Одна запись на процесс: повторно не пишем даже при повторном импорте. */
let recorded = false;

export async function recordRestart(): Promise<void> {
  if (recorded) return;
  recorded = true;
  try {
    const company = await prisma.company.findFirst({
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (!company) return;
    await prisma.appRestart.create({
      data: {
        companyId: company.id,
        rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        commit: (process.env.GIT_COMMIT || process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 12) || null,
      },
    });
  } catch {
    // Учёт не должен мешать приложению подняться.
  }
}

export interface MemoryNow {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  /** Сколько процесс живёт, в минутах. */
  uptimeMin: number;
  /** Предел, по которому pm2 перезапускает процесс, если он задан. */
  limitMb: number | null;
}

/**
 * Память прямо сейчас.
 *
 * `rss` — то самое число, на которое смотрит pm2. Куча (`heap`) меньше и
 * отвечает на другой вопрос: растёт ли расход из-за наших данных или из-за
 * самого рантайма.
 */
export function memoryNow(): MemoryNow {
  const m = process.memoryUsage();
  const mb = (n: number) => Math.round(n / 1024 / 1024);
  const raw = process.env.PM2_MAX_MEMORY_MB?.trim();
  const limit = raw && /^\d+$/.test(raw) ? Number(raw) : null;
  return {
    rssMb: mb(m.rss),
    heapUsedMb: mb(m.heapUsed),
    heapTotalMb: mb(m.heapTotal),
    uptimeMin: Math.round(process.uptime() / 60),
    limitMb: limit,
  };
}
