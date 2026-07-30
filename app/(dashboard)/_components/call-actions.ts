"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";

/**
 * Опции для формы звонка — активные услуги и источники из доменных таблиц
 * (Service, Source), а не из мок-стора. Форма занесения звонка показывает ровно
 * то, что настроено в разделах «Услуги» и «Источники».
 */
export interface CallOptions {
  services: { id: string; title: string }[];
  sources: { title: string }[];
}

export async function getCallOptions(): Promise<CallOptions> {
  const session = await getSession();
  const [services, sources] = await Promise.all([
    prisma.service.findMany({
      where: { companyId: session.companyId, isActive: true },
      orderBy: { title: "asc" },
      select: { id: true, title: true },
    }),
    prisma.source.findMany({
      where: { companyId: session.companyId, isActive: true },
      orderBy: { sortOrder: "asc" },
      select: { title: true },
    }),
  ]);
  return {
    services: services.map((s) => ({ id: s.id, title: s.title })),
    sources: sources.map((s) => ({ title: s.title })),
  };
}
