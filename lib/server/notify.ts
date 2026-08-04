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
 * Результат доставки записывается в саму строку (pushedAt / pushError). Без
 * этого сбой был невидим: уведомление в базе есть, на телефон ничего не
 * пришло, а причину — тихие часы, нет подписки, отказ службы push — узнать
 * было неоткуда.
 *
 * В тело push не кладём переписку с пациентом: текст всплывает на экране
 * блокировки, а это медицинские данные (§7).
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

/** Что произошло с доставкой конкретному получателю. */
interface DeliveryResult {
  ok: boolean;
  error: string | null;
}

async function pushToUser(companyId: string, staffUserId: string, payload: string): Promise<DeliveryResult> {
  if (!ensureVapid()) return { ok: false, error: "не заданы ключи VAPID на сервере" };

  const subs = await prisma.pushSubscription.findMany({
    where: { companyId, staffUserId },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  if (subs.length === 0) return { ok: false, error: "нет подключённых устройств" };

  let sent = 0;
  let lastError: string | null = null;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      sent += 1;
    } catch (e) {
      const err = e as { statusCode?: number; body?: string };
      lastError = `${err.statusCode ?? "сбой"}: ${String(err.body ?? "").slice(0, 120)}`;
      // 404/410 — подписка отозвана браузером, хранить её незачем.
      if (err.statusCode === 404 || err.statusCode === 410) {
        await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
      }
    }
  }
  return sent > 0 ? { ok: true, error: null } : { ok: false, error: lastError ?? "не доставлено" };
}

/**
 * Создать уведомления и отправить push. Никогда не бросает: сбой доставки не
 * должен ронять действие, ради которого уведомление возникло.
 */
export async function notifyStaff(input: NotifyInput): Promise<{ created: number; pushed: number }> {
  const recipients = [...new Set(input.recipientIds)].filter(Boolean);
  if (recipients.length === 0) return { created: 0, pushed: 0 };

  const settings = await loadNotificationSettings(input.companyId);
  // Тип, выключенный в настройках, не создаём вовсе.
  if (!typeEnabled(input.kind, settings)) return { created: 0, pushed: 0 };

  const now = new Date();
  const deliverNow = shouldPushNow({ kind: input.kind, at: now, settings: settings.quiet });
  const payload = JSON.stringify({
    title: `${CLINIC_NAME} · ${input.title}`,
    body: input.body,
    url: input.url,
  });

  let pushed = 0;
  for (const staffUserId of recipients) {
    const result: DeliveryResult = deliverNow
      ? await pushToUser(input.companyId, staffUserId, payload).catch(() => ({
          ok: false,
          error: "сбой отправки",
        }))
      : { ok: false, error: "отложено до начала смены" };
    if (result.ok) pushed += 1;

    try {
      await prisma.notification.create({
        data: {
          companyId: input.companyId,
          staffUserId,
          kind: input.kind,
          title: input.title,
          body: input.body,
          url: input.url,
          entityId: input.entityId ?? null,
          preview: input.preview?.slice(0, 200) ?? null,
          pushedAt: result.ok ? now : null,
          pushError: result.ok ? null : result.error,
        },
      });
    } catch {
      // Строка не записалась — но действие пользователя ронять нельзя.
    }
  }
  return { created: recipients.length, pushed };
}

export interface NotificationSettings {
  quiet: QuietSettings;
  escalation: boolean;
  newInquiry: boolean;
  cancel: boolean;
}

const DEFAULT_SETTINGS: NotificationSettings = {
  quiet: DEFAULT_QUIET,
  escalation: true,
  newInquiry: true,
  cancel: true,
};

function typeEnabled(kind: NotificationKind, s: NotificationSettings): boolean {
  if (kind === "ESCALATION") return s.escalation;
  if (kind === "PATIENT_MESSAGE") return s.newInquiry;
  if (kind === "BOOKING") return s.cancel;
  // Внутренний чат и служебные сообщения переключателями не отключаются.
  return true;
}

/**
 * Настройки из раздела «Настройки → Уведомления».
 *
 * Раздел сохраняет всё одним объектом под ключом notifications. Раньше здесь
 * читались отдельные ключи notifications.quietFrom и notifications.quietTo,
 * которых страница никогда не писала, — время «не беспокоить» было
 * декорацией. Читаем то, что действительно сохраняется; старые ключи из сида
 * оставлены запасным вариантом.
 */
async function loadNotificationSettings(companyId: string): Promise<NotificationSettings> {
  try {
    const rows = await prisma.setting.findMany({
      where: {
        companyId,
        key: {
          in: [
            "notifications",
            "notifications.batchWeekdays",
            "notifications.quietFrom",
            "notifications.quietTo",
          ],
        },
      },
      select: { key: true, value: true },
    });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const blob = (byKey.get("notifications") ?? null) as Partial<{
      batchWeekdays: number[];
      quietFrom: number;
      quietTo: number;
      escalation: boolean;
      newInquiry: boolean;
      cancel: boolean;
    }> | null;

    const legacyBatch = byKey.get("notifications.batchWeekdays");
    const legacyFrom = byKey.get("notifications.quietFrom");
    const legacyTo = byKey.get("notifications.quietTo");

    return {
      quiet: {
        batchWeekdays: Array.isArray(blob?.batchWeekdays)
          ? blob.batchWeekdays
          : Array.isArray(legacyBatch)
            ? (legacyBatch as number[])
            : DEFAULT_QUIET.batchWeekdays,
        quietFrom:
          typeof blob?.quietFrom === "number"
            ? blob.quietFrom
            : typeof legacyFrom === "number"
              ? legacyFrom
              : DEFAULT_QUIET.quietFrom,
        quietTo:
          typeof blob?.quietTo === "number"
            ? blob.quietTo
            : typeof legacyTo === "number"
              ? legacyTo
              : DEFAULT_QUIET.quietTo,
      },
      escalation: blob?.escalation ?? true,
      newInquiry: blob?.newInquiry ?? true,
      cancel: blob?.cancel ?? true,
    };
  } catch {
    return DEFAULT_SETTINGS;
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
