"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { countInquiriesFromDb } from "@/lib/metrics/inquiries";
import { clinicDayRange } from "@/lib/clinic-time";
import { visitTitle } from "@/lib/visit-title";

/**
 * Факты дня, которых нет в клиентском сторе.
 *
 * Обращения по §8 — это сообщения после суточной паузы, а не число диалогов:
 * посчитать их можно только по всей переписке, и делает это та же функция, что
 * и отчёты. Переносы — тем более серверные: их замечает выгрузка.
 *
 * Считаются на сервере ещё и потому, что на экране рядом стоят числа из
 * отчётов: своя арифметика в клиенте — прямой путь к двум правдам (§8).
 */

export interface MoveView {
  id: string;
  patientName: string;
  service: string;
  /** ISO — экран форматирует сам, ему виден часовой пояс. */
  fromAt: string;
  toAt: string;
  /**
   * Точный перенос или выведенный из пересоздания. На экране это разные
   * подписи: догадка не подаётся как факт.
   */
  exact: boolean;
}

export interface DayFacts {
  dayKey: string;
  /** Обращения за день по определению §8. */
  inquiries: number;
  moves: MoveView[];
  /**
   * С какого дня вообще ведётся счёт переносов. До него их не было не потому,
   * что не переносили, а потому что замечать было нечем: YCLIENTS о переносах
   * не сообщает, и восстановить их задним числом неоткуда.
   */
  movesSince: string | null;
}

export async function getDayFacts(dayKey: string): Promise<DayFacts> {
  const session = await getSession();
  const { start: from, end: to } = clinicDayRange(new Date(`${dayKey}T12:00:00Z`));

  const [totals, moves, first] = await Promise.all([
    countInquiriesFromDb(session.companyId, from, to),
    prisma.appointmentMove.findMany({
      where: { companyId: session.companyId, detectedAt: { gte: from, lt: to } },
      orderBy: { detectedAt: "desc" },
      take: 50,
      select: {
        id: true,
        fromStartAt: true,
        toStartAt: true,
        exact: true,
        appointment: {
          select: {
            patient: { select: { name: true } },
            primaryService: { select: { title: true } },
            services: { select: { service: { select: { title: true } } } },
          },
        },
      },
    }),
    prisma.appointmentMove.findFirst({
      where: { companyId: session.companyId },
      orderBy: { detectedAt: "asc" },
      select: { detectedAt: true },
    }),
  ]);

  return {
    dayKey,
    inquiries: totals.total,
    moves: moves.map((m) => ({
      id: m.id,
      patientName: m.appointment.patient?.name?.trim() || "Без имени",
      // Имя визита — это его состав, одной функцией на всю систему (§8).
      service: visitTitle(
        m.appointment.services.map((s) => ({ title: s.service.title })),
        m.appointment.primaryService?.title ?? "",
      ),
      fromAt: m.fromStartAt.toISOString(),
      toAt: m.toStartAt.toISOString(),
      exact: m.exact,
    })),
    movesSince: first?.detectedAt.toISOString() ?? null,
  };
}
