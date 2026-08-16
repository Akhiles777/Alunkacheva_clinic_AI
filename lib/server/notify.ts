import webpush from "web-push";
import { prisma } from "@/lib/db";
import { CLINIC_NAME } from "@/lib/brand";
import { vapidSubject } from "./vapid-subject";
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

let vapidState: { ok: boolean; error: string | null } | null = null;

/**
 * Настройка ключей VAPID. Раньше отсюда могло вылететь исключение: библиотека
 * бросает, если ключ задан, но не той длины или не в том формате. Наверху оно
 * попадало в общий перехват и превращалось в «сбой отправки» — причина
 * терялась, и понять, что дело в ключах на хостинге, было невозможно.
 */
export function vapidStatus(): { ok: boolean; error: string | null } {
  if (vapidState !== null) return vapidState;
  const pub = process.env.VAPID_PUBLIC;
  const priv = process.env.VAPID_PRIVATE;
  if (!pub || !priv) {
    vapidState = { ok: false, error: "не заданы VAPID_PUBLIC / VAPID_PRIVATE на хостинге" };
    return vapidState;
  }
  try {
    webpush.setVapidDetails(vapidSubject(), pub, priv);
    vapidState = { ok: true, error: null };
  } catch (e) {
    vapidState = { ok: false, error: `ключи VAPID неверны — ${String((e as Error)?.message ?? e).slice(0, 100)}` };
  }
  return vapidState;
}

export { vapidSubject } from "./vapid-subject";

/**
 * Открытый ключ, которым браузер подписывался. Если на хостинге его заменили,
 * старые подписки становятся недействительными и служба push отвечает отказом:
 * подписаться нужно заново. Сравнение с ключом подписки ловит это сразу.
 */
export function vapidPublicKey(): string {
  return process.env.VAPID_PUBLIC ?? "";
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

interface Sub {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

async function pushToUser(subs: Sub[], payload: string): Promise<DeliveryResult> {
  const vapid = vapidStatus();
  if (!vapid.ok) return { ok: false, error: vapid.error };
  if (subs.length === 0) return { ok: false, error: "нет подключённых устройств" };

  let sent = 0;
  let lastError: string | null = null;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      sent += 1;
    } catch (e) {
      const err = e as { statusCode?: number; body?: string; message?: string };
      const detail = String(err.body || err.message || "").slice(0, 120);

      /**
       * Подписка выдана под конкретный ключ сервера. Если ключ сменили, Apple
       * отвечает VapidPkHashMismatch, Google — 403: подписка мертва навсегда,
       * оживить её нечем, нужно подписаться заново.
       */
      const keyChanged = err.statusCode === 403 || /VapidPkHashMismatch/i.test(detail);
      // 404/410 — подписку отозвал сам браузер.
      const revoked = err.statusCode === 404 || err.statusCode === 410;

      lastError = keyChanged
        ? "ключи push сменились — устройство переподключится при следующем входе"
        : `${err.statusCode ?? "исключение"}: ${detail}`;

      /**
       * Мёртвую подписку удаляем. Иначе в разделе «Устройства» она значится
       * подключённой, сотрудник считает, что уведомления придут, а они не
       * приходят никогда — худший вид поломки: незаметный.
       */
      if (keyChanged || revoked) {
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
  /**
   * Прогон ассистента на живых сценариях (scripts/agent-drill.ts).
   *
   * Проверять поведение агента нужно на настоящей модели и настоящей справке
   * клиники — иначе проверяются мои представления о них, а не сама система.
   * Но будить администраторов десятками push из-за проверки нельзя. Сами
   * эскалации при этом создаются: по ним и видно, когда агент зовёт человека.
   */
  if (process.env.AGENT_DRILL === "1") return { created: 0, pushed: 0 };

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

  /**
   * Подписки всех получателей забираем одним запросом, а не по одному на
   * человека. Раньше на четверых сотрудников выходило девять обращений к базе
   * ради одного уведомления; на бессерверном хостинге это упиралось в предел
   * соединений, и тогда push молча не уходил.
   */
  const subsByUser = new Map<string, Sub[]>();
  let dbError: string | null = null;
  if (deliverNow) {
    try {
      const all = await prisma.pushSubscription.findMany({
        where: { companyId: input.companyId, staffUserId: { in: recipients } },
        select: { id: true, endpoint: true, p256dh: true, auth: true, staffUserId: true },
      });
      for (const s of all) {
        const list = subsByUser.get(s.staffUserId) ?? [];
        list.push(s);
        subsByUser.set(s.staffUserId, list);
      }
    } catch (e) {
      // База не ответила — причину сохраним в строке уведомления, чтобы сбой
      // не остался невидимым.
      dbError = String((e as Error)?.message ?? e).slice(0, 120);
    }
  }

  const results = new Map<string, DeliveryResult>();
  let pushed = 0;
  for (const staffUserId of recipients) {
    let result: DeliveryResult;
    if (!deliverNow) {
      result = { ok: false, error: "отложено до начала смены" };
    } else if (dbError) {
      result = { ok: false, error: `база недоступна — ${dbError}` };
    } else {
      // Настоящий текст ошибки, а не «сбой отправки»: обобщённая формулировка
      // ровно один раз уже стоила нескольких дней поиска причины.
      result = await pushToUser(subsByUser.get(staffUserId) ?? [], payload).catch((e) => ({
        ok: false,
        error: `сбой отправки — ${String((e as Error)?.message ?? e).slice(0, 120)}`,
      }));
    }
    if (result.ok) pushed += 1;
    results.set(staffUserId, result);
  }

  try {
    await prisma.notification.createMany({
      data: recipients.map((staffUserId) => {
        const result = results.get(staffUserId)!;
        return {
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
        };
      }),
    });
  } catch {
    // Строки не записались — но действие пользователя ронять нельзя.
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

/**
 * Кому уходит вызов администратора.
 *
 * Только администраторам — решение заказчика. Прежде звонок из диалога будил
 * заодно владельца и управляющего; на десятке обращений в день это
 * превращается в поток, который перестают читать. Отвечает пациенту
 * администратор, ему и уведомление.
 *
 * Если администраторов в клинике не заведено, уведомление всё же уходит
 * остальным: молчание тут хуже лишнего звука — обращение просто потеряется.
 */
export async function escalationRecipients(companyId: string): Promise<string[]> {
  const admins = await prisma.staffUser.findMany({
    where: { companyId, deletedAt: null, isActive: true, role: "ADMIN" },
    select: { id: true },
  });
  if (admins.length > 0) return admins.map((u) => u.id);
  return inboxRecipients(companyId);
}
