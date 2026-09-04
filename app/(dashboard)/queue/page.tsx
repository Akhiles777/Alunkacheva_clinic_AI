import { getSession } from "@/lib/server/session";
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
