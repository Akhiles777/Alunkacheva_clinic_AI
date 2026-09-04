import { getSession } from "@/lib/server/session";
import { can } from "@/lib/server/authz";
import {
  ATTRIBUTION_DAYS,
  freeSlotsAhead,
  getCallbackQueue,
} from "@/lib/server/callback-queue";
import { QueueClient, type QueueData } from "./queue-client";

export const metadata = { title: "Кому позвонить" };

/**
 * Очередь «Кому позвонить» и свободные окна рядом.
 *
 * Считает сервер: экран только показывает. Окна нужны в том же кадре — звонок
 * без окна бесполезен, «приходите когда-нибудь» записью не становится.
 */
export default async function QueuePage() {
  const session = await getSession();
  /**
   * Список для тех, кто пишет пациентам. Врачу он не нужен и не полагается:
   * это имена, суммы и поводы по всей базе, а не его приём (§7).
   */
  if (!(await can(session, "MESSAGE_PATIENTS"))) {
    return (
      <div className="flex-1 overflow-auto px-7 py-8 max-md:px-5">
        <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">Кому позвонить</h1>
        <p className="text-text-muted mt-3 max-w-[60ch] text-sm leading-relaxed">
          Раздел доступен тем, кто ведёт переписку с пациентами. Права выдаёт владелец в
          «Настройки → Сотрудники».
        </p>
      </div>
    );
  }
  const [queue, slots] = await Promise.all([
    getCallbackQueue(session.companyId),
    freeSlotsAhead(session.companyId, 3),
  ]);

  const data: QueueData = {
    rows: queue.rows,
    withoutThreshold: queue.withoutThreshold,
    outcome: queue.outcome,
    slots,
    attributionDays: ATTRIBUTION_DAYS,
  };

  return <QueueClient data={data} />;
}
