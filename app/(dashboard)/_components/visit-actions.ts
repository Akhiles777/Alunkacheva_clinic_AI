"use server";

import { getSessionOrNull } from "@/lib/server/session";
import { writeAudit } from "@/lib/server/audit";
import { idFromRoute, routePattern } from "@/lib/metrics/route-pattern";

/**
 * Отметка об открытии экрана.
 *
 * Журнал отвечал только на «кто входил в систему». На вопросы «кто открывал
 * этот диалог» и «чем сотрудник занимался весь день» ответа не было вовсе —
 * оттого в разделе учёта и было видно так мало.
 *
 * ПЛАТФОРМА ОТ ЭТОГО НЕ ЖДЁТ. Вызывают отсюда, с самого экрана, и не дожидаясь
 * ответа: переход между разделами не задерживается ни на миллисекунду, а
 * неудачная запись ничего не ломает. Если бы отметка стояла на пути отрисовки,
 * каждая навигация ждала бы запись в базу — ровно то, чего просили избежать.
 *
 * Повторы отсекает сам экран: один и тот же раздел, открытый десять раз за
 * пять минут, пишется один раз. Иначе список превратился бы в ленту переходов
 * туда-обратно, в которой не видно работы.
 */
export async function noteVisit(pathname: string, dialogId?: string | null): Promise<void> {
  const session = await getSessionOrNull();
  // Без сессии писать нечего: это не ошибка, а страница входа.
  if (!session?.userId) return;

  /**
   * Диалог — отдельный вид действия, а не просто «открыл инбокс».
   *
   * «Кто и когда открывал эту переписку» — первый вопрос при разборе спорного
   * случая, и отвечать на него «открывал раздел Диалоги» бессмысленно.
   */
  if (dialogId) {
    await writeAudit({
      companyId: session.companyId,
      actorId: session.userId,
      action: "CONVERSATION_VIEW",
      entityType: "/inbox",
      entityId: dialogId,
    }).catch(() => {
      // Учёт не должен мешать работе — ни здесь, ни где-либо ещё.
    });
    return;
  }

  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "PAGE_VIEW",
    // Образец адреса, а не сам адрес: параметры запроса содержат ПДн (§7).
    entityType: routePattern(pathname),
    entityId: idFromRoute(pathname),
  }).catch(() => {});
}
