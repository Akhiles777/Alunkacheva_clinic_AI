"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import type { Observation } from "@/lib/metrics/digest";

/**
 * История еженедельных сводок.
 *
 * Хранить их нужно ровно затем, зачем владелец о них спрашивает: вернуться и
 * посмотреть, что писали месяц назад. Сводка, живущая до следующего
 * понедельника, отвечает только на вопрос «что сейчас», а он и так виден на
 * экране отчётов.
 */

export interface DigestView {
  id: string;
  label: string;
  text: string;
  byModel: boolean;
  hasBaseline: boolean;
  observations: Observation[];
  createdAt: string;
}

/** Сколько сводок держим на экране. Дальше — уже архив, а не работа. */
const LIMIT = 12;

export async function getWeeklyDigests(): Promise<DigestView[]> {
  const session = await getSession();
  // Сводка — это выручка и загрузка: то же право, что и у остального кабинета (§9).
  await requirePermission(session, "VIEW_REVENUE");

  const rows = await prisma.weeklyDigest.findMany({
    where: { companyId: session.companyId },
    orderBy: { weekStart: "desc" },
    take: LIMIT,
    select: {
      id: true,
      label: true,
      text: true,
      byModel: true,
      hasBaseline: true,
      observations: true,
      createdAt: true,
    },
  });

  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    text: r.text,
    byModel: r.byModel,
    hasBaseline: r.hasBaseline,
    observations: Array.isArray(r.observations) ? (r.observations as unknown as Observation[]) : [],
    createdAt: r.createdAt.toISOString(),
  }));
}
