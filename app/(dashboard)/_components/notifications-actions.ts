"use server";

import webpush from "web-push";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { getCurrentUser } from "./user-actions";
import { todayRangeMoscow } from "@/lib/schedule";

/**
 * Уведомления для всех ролей: в приложении (колокольчик) и push (PWA). Пункты
 * считаются из данных под роль текущего пользователя. Push — через VAPID.
 */
export interface NotificationItem {
  id: string;
  text: string;
  url: string;
  urgent: boolean;
}

let vapidReady = false;
function ensureVapid(): boolean {
  if (vapidReady) return true;
  const pub = process.env.VAPID_PUBLIC;
  const priv = process.env.VAPID_PRIVATE;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@mera.clinic", pub, priv);
  vapidReady = true;
  return true;
}

export async function getNotifications(): Promise<NotificationItem[]> {
  const session = await getSession();
  const user = await getCurrentUser();
  const { start, end } = todayRangeMoscow();
  const items: NotificationItem[] = [];

  const escalated = await prisma.conversation.count({
    where: { companyId: session.companyId, status: "ESCALATED" },
  });
  if (escalated > 0) {
    items.push({ id: "esc", text: `${escalated} диалог(а) требуют ответа`, url: "/inbox", urgent: true });
  }

  if (user.role === "doctor") {
    const mine = await prisma.appointment.count({
      where: {
        companyId: session.companyId,
        deletedAt: null,
        staff: { name: user.name },
        startAt: { gte: start, lt: end },
      },
    });
    if (mine > 0) items.push({ id: "myday", text: `${mine} приём(ов) у вас сегодня`, url: "/doctor", urgent: false });
  } else {
    const [newPatients, todayAppts] = await Promise.all([
      prisma.patient.count({ where: { companyId: session.companyId, deletedAt: null, firstSeenAt: { gte: start, lt: end } } }),
      prisma.appointment.count({ where: { companyId: session.companyId, deletedAt: null, startAt: { gte: start, lt: end }, status: { not: "CANCELLED" } } }),
    ]);
    if (newPatients > 0) items.push({ id: "newp", text: `${newPatients} новых пациент(ов) сегодня`, url: "/patients", urgent: false });
    if (todayAppts > 0) items.push({ id: "appts", text: `${todayAppts} записей на сегодня`, url: "/schedule", urgent: false });
  }

  return items;
}

export async function getVapidPublicKey(): Promise<string> {
  return process.env.NEXT_PUBLIC_VAPID_PUBLIC || process.env.VAPID_PUBLIC || "";
}

export async function subscribePush(sub: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<{ ok: boolean }> {
  const session = await getSession();
  if (!session.userId) return { ok: false };
  await prisma.pushSubscription.upsert({
    where: { endpoint: sub.endpoint },
    update: { p256dh: sub.keys.p256dh, auth: sub.keys.auth, staffUserId: session.userId, failureCount: 0 },
    create: {
      companyId: session.companyId,
      staffUserId: session.userId,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
    },
  });
  return { ok: true };
}

/** Отправить push текущему пользователю (проверка, что уведомления работают). */
export async function sendTestPush(): Promise<{ sent: number }> {
  const session = await getSession();
  if (!session.userId || !ensureVapid()) return { sent: 0 };
  const subs = await prisma.pushSubscription.findMany({
    where: { companyId: session.companyId, staffUserId: session.userId },
  });
  const payload = JSON.stringify({ title: "Мера", body: "Уведомления включены ✓", url: "/" });
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      sent += 1;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
      }
    }
  }
  return { sent };
}
