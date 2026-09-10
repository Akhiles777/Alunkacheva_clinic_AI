"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import { requireId } from "@/lib/server/require-id";
import { writeAudit } from "@/lib/server/audit";
import {
  qualityProblems,
  qualitySummary,
  type QualityProblem,
  type QualitySummary,
} from "@/lib/server/agent-quality";

/**
 * Разбор проверок качества человеком.
 *
 * Вердикт проверяющей модели — не приговор. Она ошибается ровно так же, как
 * проверяемая: называет отклонением дословную справку, не видит контекста
 * прошлых реплик. Поэтому список — это работа для человека, а не отчёт о
 * найденных нарушениях, и число «проблем» на экране всегда стоит рядом с тем,
 * сколько из них человек подтвердил.
 */

/** Список и итог возвращаются вместе: врозь они на экране разъезжаются. */
export interface QualityState {
  problems: QualityProblem[];
  summary: QualitySummary;
}

async function stateOf(companyId: string): Promise<QualityState> {
  const [problems, summary] = await Promise.all([
    qualityProblems(companyId),
    qualitySummary(companyId),
  ]);
  return { problems, summary };
}

/**
 * Подтвердить или отклонить вердикт.
 *
 * Обе кнопки убирают строку из списка: разобранное не должно висеть. Разница в
 * том, что подтверждённое идёт в счёт качества, а отклонённое — в счёт ошибок
 * самой проверки, и оба числа видны рядом.
 */
export async function reviewQualityCheck(
  id: string,
  confirmed: boolean,
): Promise<QualityState> {
  requireId(id, "проверка");
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");

  const { count } = await prisma.agentQualityCheck.updateMany({
    where: { id, companyId: session.companyId },
    data: { confirmed, reviewedById: session.userId ?? null, reviewedAt: new Date() },
  });
  if (count > 0) {
    await writeAudit({
      companyId: session.companyId,
      actorId: session.userId,
      action: "SETTINGS_UPDATE",
      entityType: "agent_quality_check",
      entityId: id,
      meta: { confirmed },
    }).catch(() => {
      // Журнал не должен ронять разбор.
    });
  }
  /**
   * Возвращаем и список, и счётчики. Обновляя один список, экран показывал
   * «подтверждено 0» сразу после подтверждения: строка уходила, а число под
   * ней оставалось прежним до перезагрузки страницы — и решение человека
   * выглядело непринятым.
   */
  return stateOf(session.companyId);
}
