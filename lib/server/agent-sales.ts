import { prisma } from "@/lib/db";
import { looksLikeIntake } from "@/lib/agent/intake";
import { visitTitle } from "@/lib/visit-title";
import { withoutQuote } from "@/lib/agent/quoted";
import {
  SALE_WINDOW_HOURS,
  salesOf,
  totalsOf,
  type AgentSale,
  type AgentSalesTotals,
} from "@/lib/metrics/agent-sales";

/**
 * Что ассистент довёл до записи — из базы.
 *
 * Чтение и склейка; правило продажи считает чистая функция
 * `lib/metrics/agent-sales.ts`, и она же покрыта тестами. Экран владельца и
 * ИИ-аналитик читают эти числа отсюда — одна метрика, одна функция (§8).
 *
 * Считается по фактам переписки за любой прошлый период: заказчик просил
 * разобрать и прошлые разговоры, чтобы не начинать счёт с нуля.
 */

export interface AgentSalesReport extends AgentSalesTotals {
  /** Отдельные продажи — для модального окна: видно, что именно засчитано. */
  sales: (AgentSale & { patientName: string | null; channel: string })[];
  from: Date;
  to: Date;
}

export async function getAgentSales(
  companyId: string,
  from: Date,
  to: Date,
): Promise<AgentSalesReport> {
  /**
   * Берём диалоги, где в этот период вообще был разговор. Записи ищем шире —
   * администратор ставит время не мгновенно (SALE_WINDOW_HOURS).
   */
  const conversations = await prisma.conversation.findMany({
    where: {
      companyId,
      deletedAt: null,
      // Тренировочные переписки — учёба сотрудника, а не работа ассистента.
      isPractice: false,
      messages: { some: { createdAt: { gte: from, lt: to }, deletedAt: null, isDraft: false } },
    },
    select: {
      id: true,
      channel: true,
      patientId: true,
      contactName: true,
      patient: { select: { name: true } },
      messages: {
        where: { deletedAt: null, isDraft: false, createdAt: { gte: from, lt: to } },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true, direction: true, authorType: true, body: true },
      },
    },
  });

  const patientIds = [...new Set(conversations.map((c) => c.patientId).filter(Boolean))] as string[];
  const appointments = patientIds.length
    ? await prisma.appointment.findMany({
        where: {
          companyId,
          patientId: { in: patientIds },
          deletedAt: null,
          createdAt: { gte: from, lt: new Date(to.getTime() + SALE_WINDOW_HOURS * 3600 * 1000) },
        },
        select: {
          id: true,
          patientId: true,
          createdAt: true,
          status: true,
          revenue: true,
          primaryService: { select: { title: true } },
          services: { select: { service: { select: { title: true } } } },
        },
      })
    : [];

  const byPatient = new Map<string, typeof appointments>();
  for (const a of appointments) {
    const list = byPatient.get(a.patientId) ?? [];
    list.push(a);
    byPatient.set(a.patientId, list);
  }

  const sales: AgentSalesReport["sales"] = [];
  for (const conv of conversations) {
    const own = conv.patientId ? (byPatient.get(conv.patientId) ?? []) : [];
    const found = salesOf(
      {
        conversationId: conv.id,
        patientId: conv.patientId,
        /**
         * Цитату снимаем: отвечая свайпом, человек присылает и текст клиники,
         * а анкету надо узнавать по его собственным словам (lib/agent/quoted).
         */
        messages: conv.messages.map((m) => ({
          at: m.createdAt,
          direction: m.direction,
          authorType: m.authorType as "PATIENT" | "BOT" | "STAFF",
          body: withoutQuote(m.body),
        })),
        appointments: own.map((a) => ({
          id: a.id,
          createdAt: a.createdAt,
          status: a.status,
          revenue: Number(a.revenue),
          serviceTitles: [
            visitTitle(
              a.services.map((x) => ({ title: x.service.title })),
              a.primaryService?.title ?? "услуга не указана",
            ),
          ],
        })),
      },
      looksLikeIntake,
    );
    for (const sale of found) {
      sales.push({
        ...sale,
        patientName: conv.patient?.name ?? conv.contactName ?? null,
        channel: conv.channel,
      });
    }
  }

  return { ...totalsOf(sales), sales: sales.sort((a, b) => b.at.getTime() - a.at.getTime()), from, to };
}
