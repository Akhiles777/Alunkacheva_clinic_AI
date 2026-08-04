import webpush from "web-push";
import { prisma } from "@/lib/db";
import { CLINIC_MAIL_DOMAIN, CLINIC_NAME } from "@/lib/brand";
import type { NotificationKind } from "@/generated/prisma/enums";
import { DEFAULT_QUIET, shouldPushNow, type QuietSettings } from "./notify-window";

/**
 * Уведомления сотрудникам: строка в базе плюс push на устройство.
 *
 * Уведомление — событие, а не счётчик. Только у события есть «прочитано»:
 * раньше колокольчик пересчитывал цифры из данных, и убрать оттуда пункт было
 * нечем.
 *
 * В тело push не кладём переписку с пациентом: текст всплывает на экране
 * блокировки, а это медицинские данные (§7). Отправляем повод и ссылку.
 */

let vapidReady: boolean | null = null;

function ensureVapid(): boolean {
  if (vapidReady !== null) return vapidReady;
  const pub = process.env.VAPID_PUBLIC;
  const priv = process.env.VAPID_PRIVATE;
  if (!pub || !priv) {
    vapidReady = false;
    return false;
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || `mailto:admin@${CLINIC_MAIL_DOMAIN}`, pub, priv);
  vapidReady = true;
  return true;
}

export interface NotifyInput {
  companyId: string;
  /** Кому. Пустой список — просто ничего не делаем. */
  recipientIds: string[];
  kind: NotificationKind;
  title: string;
  body: string;
  url: string;
  entityId?: string;
  /** Начало текста сообщения — только для колокольчика, не для push. */
  preview?: string;
}

/** Разослать push по всем подпискам получателей. Мёртвые подписки удаляем. */
async function pushTo(companyId: string, recipientIds: string[], payload: string): Promise<number> {
  if (!ensureVapid() || recipientIds.length === 0) return 0;
  const subs = await prisma.pushSubscription.findMany({
    where: { companyId, staffUserId: { in: recipientIds } },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      sent += 1;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      // 404/410 — подписка отозвана браузером, хранить её незачем.
      if (status === 404 || status === 410) {
        await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
      }
    }
  }
  return sent;
}

/**
 * Создать уведомления и отправить push. Никогда не бросает: сбой доставки не
 * должен ронять действие, ради которого уведомление возникло (отправку
 * сообщения, запись на приём).
 */
export async function notifyStaff(input: NotifyInput): Promise<{ created: number; pushed: number }> {
  const recipients = [...new Set(input.recipientIds)].filter(Boolean);
  if (recipients.length === 0) return { created: 0, pushed: 0 };

  try {
    await prisma.notification.createMany({
      data: recipients.map((staffUserId) => ({
        companyId: input.companyId,
        staffUserId,
        kind: input.kind,
        title: input.title,
        body: input.body,
        url: input.url,
        entityId: input.entityId ?? null,
        preview: input.preview?.slice(0, 200) ?? null,
      })),
    });
  } catch {
    return { created: 0, pushed: 0 };
  }

  // Уведомление уже создано и лежит в колокольчике. Дальше решаем только,
  // будить ли телефон прямо сейчас: в воскресенье и ночью несрочное копится
  // до смены (§4.9, пожелание заказчика).
  const quiet = await loadQuietSettings(input.companyId);
  if (!shouldPushNow({ kind: input.kind, at: new Date(), settings: quiet })) {
    return { created: recipients.length, pushed: 0 };
  }

  const payload = JSON.stringify({
    title: `${CLINIC_NAME} · ${input.title}`,
    body: input.body,
    url: input.url,
  });
  const pushed = await pushTo(input.companyId, recipients, payload).catch(() => 0);
  return { created: recipients.length, pushed };
}

/** Настройки тихих часов из БД; нет строки — берём разумные значения. */
async function loadQuietSettings(companyId: string): Promise<QuietSettings> {
  try {
    const rows = await prisma.setting.findMany({
      where: {
        companyId,
        key: { in: ["notifications.batchWeekdays", "notifications.quietFrom", "notifications.quietTo"] },
      },
      select: { key: true, value: true },
    });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const batch = byKey.get("notifications.batchWeekdays");
    const from = byKey.get("notifications.quietFrom");
    const to = byKey.get("notifications.quietTo");
    return {
      batchWeekdays: Array.isArray(batch) ? (batch as number[]) : DEFAULT_QUIET.batchWeekdays,
      quietFrom: typeof from === "number" ? from : DEFAULT_QUIET.quietFrom,
      quietTo: typeof to === "number" ? to : DEFAULT_QUIET.quietTo,
    };
  } catch {
    return DEFAULT_QUIET;
  }
}

/** Сотрудники, которым положено знать о пациентских каналах. Врачи — нет (§9). */
export async function inboxRecipients(companyId: string, exceptUserId?: string | null): Promise<string[]> {
  const users = await prisma.staffUser.findMany({
    where: {
      companyId,
      deletedAt: null,
      isActive: true,
      role: { in: ["OWNER", "ADMIN", "MANAGER"] },
      ...(exceptUserId ? { id: { not: exceptUserId } } : {}),
    },
    select: { id: true },
  });
  return users.map((u) => u.id);
}
