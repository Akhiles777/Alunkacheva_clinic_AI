"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { notifyStaff } from "@/lib/server/notify";

/**
 * Колокольчик: реальные события из таблицы Notification, а не пересчитанные
 * счётчики. Поэтому у каждого пункта есть «прочитано», и список действительно
 * очищается.
 */
export interface NotificationItem {
  id: string;
  text: string;
  title: string;
  url: string;
  urgent: boolean;
  createdAt: string;
  /** Начало сообщения — чтобы понять суть, не открывая диалог. */
  preview: string | null;
  /** Почему push не ушёл. null — ушёл или не требовался. */
  pushError: string | null;
}

const URGENT_KINDS = new Set(["ESCALATION", "PATIENT_MESSAGE"]);

export async function getNotifications(): Promise<NotificationItem[]> {
  const session = await getSession();
  if (!session.userId) return [];

  const rows = await prisma.notification.findMany({
    where: { companyId: session.companyId, staffUserId: session.userId, readAt: null },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { id: true, kind: true, title: true, body: true, url: true, createdAt: true, preview: true, pushError: true },
  });

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    text: r.body,
    url: r.url,
    urgent: URGENT_KINDS.has(r.kind),
    createdAt: r.createdAt.toISOString(),
    preview: r.preview,
    pushError: r.pushError,
  }));
}

/** Пометить одно уведомление прочитанным. */
export async function markNotificationRead(id: string): Promise<NotificationItem[]> {
  const session = await getSession();
  if (!session.userId) return [];
  await prisma.notification.updateMany({
    where: { id, staffUserId: session.userId, readAt: null },
    data: { readAt: new Date() },
  });
  return getNotifications();
}

/** Прочитать все — кнопка «очистить» в виджете. */
export async function markAllNotificationsRead(): Promise<NotificationItem[]> {
  const session = await getSession();
  if (!session.userId) return [];
  await prisma.notification.updateMany({
    where: { companyId: session.companyId, staffUserId: session.userId, readAt: null },
    data: { readAt: new Date() },
  });
  return getNotifications();
}

export async function getVapidPublicKey(): Promise<string> {
  return process.env.NEXT_PUBLIC_VAPID_PUBLIC || process.env.VAPID_PUBLIC || "";
}

export async function subscribePush(
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  userAgent?: string,
): Promise<{ ok: boolean }> {
  const session = await getSession();
  if (!session.userId) return { ok: false };
  await prisma.pushSubscription.upsert({
    where: { endpoint: sub.endpoint },
    update: { p256dh: sub.keys.p256dh, auth: sub.keys.auth, staffUserId: session.userId, failureCount: 0, userAgent: userAgent ?? null },
    create: {
      companyId: session.companyId,
      staffUserId: session.userId,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      userAgent: userAgent ?? null,
    },
  });
  return { ok: true };
}

/** Проверка, что push доходит: уведомление себе. */
export async function sendTestPush(): Promise<{ sent: number }> {
  const session = await getSession();
  if (!session.userId) return { sent: 0 };
  const res = await notifyStaff({
    companyId: session.companyId,
    recipientIds: [session.userId],
    kind: "SYSTEM",
    title: "Уведомления включены",
    body: "Push работает — так будут приходить сообщения и эскалации.",
    url: "/",
  });
  return { sent: res.pushed };
}
