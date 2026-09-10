import { prisma } from "@/lib/db";
import { pairMoves, PAIR_WINDOW_DAYS } from "@/lib/metrics/reschedule";

/**
 * Визиты, исчезнувшие из YCLIENTS.
 *
 * Жалоба клиники: «в YCLIENTS запись отменили, а у нас она осталась и
 * отмечена как пришёл». Так и есть, и причина не в ошибке разбора. Удалённая
 * запись просто перестаёт приходить в списке — она не помечена удалённой, её
 * там больше нет вовсе. Выгрузка обновляет только то, что видит, поэтому
 * последнее известное состояние визита остаётся у нас навсегда: с отметкой
 * «пришёл», с выручкой и в отчётах.
 *
 * Лечится это не разбором отдельных полей, а сверкой множеств: за каждое
 * выгруженное окно мы знаем ПОЛНЫЙ список записей YCLIENTS. Всё наше, чего в
 * этом списке нет, в YCLIENTS отменено или удалено. Это тот же приём, что и с
 * доборами: проверяем результат, а не гадаем о причинах.
 *
 * Опасность здесь в обратную сторону: недобранная страница выглядит как
 * массовая отмена, и одна такая ошибка вычистит месяц настоящих визитов.
 * Поэтому сверка применяется только к окну, которому можно верить, — см.
 * windowIsTrustworthy.
 */

export interface WindowFetch {
  /** Сколько записей фактически получили за окно. */
  fetched: number;
  /** Сколько всего обещал сервер, если сообщил. */
  totalCount: number | null;
}

/**
 * Можно ли по этому окну отменять визиты.
 *
 * Два условия, и оба про полноту, а не про качество данных:
 *
 * 1. Окно вернуло хоть что-то. Пустой ответ по месяцу, где у нас две сотни
 *    визитов, — это почти наверняка сбой на стороне провайдера, а не двести
 *    отмен за раз.
 * 2. Мы добрали все страницы. Если сервер сообщил общее число и мы получили
 *    меньше, часть записей осталась за кадром — и каждая из них выглядит
 *    исчезнувшей.
 */
export function windowIsTrustworthy(f: WindowFetch): boolean {
  if (f.fetched <= 0) return false;
  if (typeof f.totalCount === "number" && f.totalCount > f.fetched) return false;
  return true;
}

export interface VanishResult {
  /** Сколько визитов помечено удалёнными: в YCLIENTS их больше нет. */
  removed: number;
}

/**
 * Убрать наши визиты окна, которых YCLIENTS больше не показывает.
 *
 * Трогаем только те, что когда-то пришли ОТТУДА (есть yclientsRecordId).
 * Созданные у нас и ещё не отправленные визиты к этой сверке отношения не
 * имеют: их отсутствие в YCLIENTS — нормальное состояние, а не удаление.
 *
 * Помечаем удалёнными, а не отменёнными. Разница видна пациенту: отменённый
 * визит — событие, о котором договорились, и он остаётся в карточке; удалённая
 * запись — та, которой в YCLIENTS больше нет вовсе. Пока такие записи
 * становились «отменёнными», перенос приёма плодил призраков: администратор
 * пересоздал запись дважды, и в карточке на один слот стояло три строки —
 * «отменён», «отменён» и «запланирован». Понять по ней, придёт человек или
 * нет, стало нельзя.
 *
 * Строку из базы не убираем: восстановить связь дешевле, чем потерять
 * историю, — если YCLIENTS покажет запись снова, выгрузка снимет отметку
 * (`deletedAt: null`) и визит вернётся как был. А все экраны и отчёты
 * отбирают по `deletedAt: null`, поэтому из них он уходит сразу.
 */
export async function removeVanished(
  companyId: string,
  window: { from: Date; to: Date },
  /**
   * Все номера, которые YCLIENTS показал за ЭТУ выгрузку целиком, а не только
   * за это окно.
   *
   * Иначе перенос записи на другой месяц выглядит как удаление: в старом окне
   * её номера уже нет, а в новом он ещё не встретился. Отменили бы живую
   * запись и сами создали расхождение.
   */
  seenIds: number[],
  trusted: boolean,
): Promise<VanishResult> {
  if (!trusted) return { removed: 0 };

  /**
   * Что именно исчезает — читаем ДО отметки: после неё уже не отличить эти
   * записи от тех, что убрали в прошлые круги.
   */
  const vanishing = await prisma.appointment.findMany({
    where: {
      companyId,
      deletedAt: null,
      startAt: { gte: window.from, lt: window.to },
      yclientsRecordId: { not: null, notIn: seenIds },
    },
    select: { id: true, patientId: true, startAt: true },
  });

  const result = await prisma.appointment.updateMany({
    where: {
      companyId,
      deletedAt: null,
      startAt: { gte: window.from, lt: window.to },
      yclientsRecordId: { not: null, notIn: seenIds },
    },
    data: { deletedAt: new Date() },
  });

  await recordDerivedMoves(companyId, vanishing);

  return { removed: result.count };
}

/**
 * Перенос, сделанный пересозданием.
 *
 * Администратор удаляет запись и заводит новую — со стороны YCLIENTS это
 * просто исчезновение и появление, и связать их можно только выводом. Поэтому
 * такие переносы помечены `exact: false`, а на экране подписаны иначе:
 * догадка не подаётся как факт (§9).
 *
 * Правила сопоставления живут в `lib/metrics/reschedule.ts` и проверяются
 * тестами — они узкие намеренно: лучше не заметить перенос, чем назвать
 * переносом отдельную запись.
 */
async function recordDerivedMoves(
  companyId: string,
  vanished: { id: string; patientId: string | null; startAt: Date }[],
): Promise<void> {
  const patientIds = [...new Set(vanished.map((v) => v.patientId).filter((id): id is string => !!id))];
  if (patientIds.length === 0) return;

  const now = new Date();
  const candidates = await prisma.appointment.findMany({
    where: {
      companyId,
      deletedAt: null,
      patientId: { in: patientIds },
      createdAtYclients: { gte: new Date(now.getTime() - PAIR_WINDOW_DAYS * 24 * 3600 * 1000) },
    },
    select: { id: true, patientId: true, startAt: true, createdAtYclients: true },
  });

  const moves = pairMoves(
    vanished.map((v) => ({ appointmentId: v.id, patientId: v.patientId, startAt: v.startAt })),
    candidates.map((c) => ({
      appointmentId: c.id,
      patientId: c.patientId,
      startAt: c.startAt,
      createdAt: c.createdAtYclients ?? c.startAt,
    })),
    now,
  );

  for (const m of moves) {
    await prisma.appointmentMove
      .create({
        data: {
          companyId,
          appointmentId: m.appointmentId,
          patientId: m.patientId,
          fromStartAt: m.fromStartAt,
          toStartAt: m.toStartAt,
          exact: false,
        },
      })
      .catch(() => {
        // Уже записан: уникальный индекс, нормальный исход повторной выгрузки.
      });
  }
}
