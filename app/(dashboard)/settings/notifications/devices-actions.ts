"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { deviceLabel } from "@/lib/user-agent";

/**
 * Устройства, на которые приходят push. Раньше в этом разделе был нарисован
 * один выдуманный «Chrome · MacBook Ирины», а кнопки ничего не делали —
 * подключить устройство было физически негде.
 */
export interface DeviceRow {
  id: string;
  title: string;
  addedAt: string;
  isCurrent: boolean;
}


export async function getDevices(currentEndpoint?: string): Promise<DeviceRow[]> {
  const session = await getSession();
  if (!session.userId) return [];
  const rows = await prisma.pushSubscription.findMany({
    where: { companyId: session.companyId, staffUserId: session.userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, endpoint: true, userAgent: true, createdAt: true },
  });
  return rows.map((r) => ({
    id: r.id,
    title: deviceLabel(r.userAgent),
    addedAt: new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" }).format(r.createdAt),
    isCurrent: currentEndpoint ? r.endpoint === currentEndpoint : false,
  }));
}

export async function removeDevice(id: string): Promise<DeviceRow[]> {
  const session = await getSession();
  if (!session.userId) return [];
  await prisma.pushSubscription.deleteMany({
    where: { id, companyId: session.companyId, staffUserId: session.userId },
  });
  return getDevices();
}
