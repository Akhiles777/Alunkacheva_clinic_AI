import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { vapidPublicKey, vapidStatus, vapidSubject } from "@/lib/server/notify";
import { checkVapidKeys } from "@/lib/server/vapid-keys";

/**
 * Проверка окружения. Отдаёт только факт «переменная задана», без значений —
 * секреты наружу не уходят.
 *
 * Нужна, потому что «не приходит push» и «ассистент зовёт человека на любой
 * вопрос» — это почти всегда незаданная переменная на хостинге, а не ошибка в
 * коде. Без такой страницы приходится гадать.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const env = {
    DATABASE_URL: Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PRISMA_DATABASE_URL),
    SESSION_SECRET: Boolean(process.env.SESSION_SECRET || process.env.CREDENTIAL_MASTER_KEY),
    CREDENTIAL_MASTER_KEY: Boolean(process.env.CREDENTIAL_MASTER_KEY),
    ROUTER_AI: Boolean(process.env.ROUTER_AI),
    VAPID_PUBLIC: Boolean(process.env.VAPID_PUBLIC),
    VAPID_PRIVATE: Boolean(process.env.VAPID_PRIVATE),
    NEXT_PUBLIC_VAPID_PUBLIC: Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC),
    TELEGRAM_BOT_TOKEN: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    WHATSAPP_ENABLED: process.env.WHATSAPP_ENABLED === "true",
    GREEN_API_WEBHOOK_SECRET: Boolean(process.env.GREEN_API_WEBHOOK_SECRET),
    TELEGRAM_WEBHOOK_SECRET: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
  };

  /**
   * Какие модели реально используются этим экземпляром. Имена моделей — не
   * секрет, а без них невозможно понять, почему счёт у провайдера не падает:
   * переменная ROUTER_AI_MODEL на хостинге перебивает значение из кода.
   */
  const models = {
    аналитик: process.env.ROUTER_AI_MODEL || "anthropic/claude-sonnet-4.5 (по умолчанию)",
    ботПациентов:
      process.env.ROUTER_AI_BOT_MODEL ||
      process.env.ROUTER_AI_MODEL ||
      "anthropic/claude-haiku-4.5 (по умолчанию)",
    переопределеноПеременной: Boolean(process.env.ROUTER_AI_MODEL || process.env.ROUTER_AI_BOT_MODEL),
  };

  /**
   * Проверка ключей push. Одного факта «переменная задана» мало: ключ может
   * быть задан и при этом не подходить — тогда отправка падает на каждом
   * событии, а выглядит это как «push просто не приходит».
   */
  const vapid = vapidStatus();
  const keys = checkVapidKeys(process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);
  const push = {
    ключиРабочие: vapid.ok,
    ошибка: vapid.error,
    размерыКлючей: keys.note,
    открытыйКлючСовпадаетСКлиентским:
      Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC) &&
      process.env.NEXT_PUBLIC_VAPID_PUBLIC === vapidPublicKey(),
    контактОтправителя: vapidSubject(),
  };

  let db: Record<string, number | string> = { ok: "нет связи" };
  try {
    const [knowledge, pushSubs, staff, conversations] = await Promise.all([
      prisma.knowledgeEntry.count({ where: { isActive: true } }),
      prisma.pushSubscription.count(),
      prisma.staffUser.count({ where: { deletedAt: null } }),
      prisma.conversation.count(),
    ]);
    // Последние неудачи доставки: сразу видно, почему push не дошёл.
    const failed = await prisma.notification.findMany({
      where: { pushError: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { kind: true, pushError: true, createdAt: true, staffUser: { select: { login: true } } },
    });
    db = {
      knowledgeEntries: knowledge,
      pushSubscriptions: pushSubs,
      staffUsers: staff,
      conversations,
      lastPushProblems: failed
        .map((f) => `${f.createdAt.toISOString().slice(5, 16)} ${f.kind} → ${f.staffUser.login}: ${f.pushError}`)
        .join(" | ") || "нет",
    };
  } catch {
    // Оставляем пометку об отсутствии связи.
  }

  // Подсказки: что именно сломается при пустой переменной.
  const warnings: string[] = [];
  if (!env.ROUTER_AI) warnings.push("Нет ROUTER_AI — ассистент не может отвечать своими словами и зовёт человека");
  if (!push.ключиРабочие) warnings.push(`Push не отправляется: ${vapid.error}`);
  if (!keys.ok) {
    warnings.push(
      `Ключи VAPID заданы неверно: ${keys.note}. Сгенерируйте пару командой ` +
        "npx web-push generate-vapid-keys и впишите её в переменные хостинга.",
    );
  }
  if (process.env.VAPID_SUBJECT && process.env.VAPID_SUBJECT.trim() !== push.контактОтправителя) {
    warnings.push(
      "VAPID_SUBJECT на хостинге задан неверно (ожидается mailto:адрес или https://адрес) — " +
        `значение проигнорировано, используется ${push.контактОтправителя}. Исправьте переменную.`,
    );
  }
  if (push.ключиРабочие && !push.открытыйКлючСовпадаетСКлиентским) {
    warnings.push(
      "NEXT_PUBLIC_VAPID_PUBLIC не совпадает с VAPID_PUBLIC — браузер подписывается одним ключом, " +
        "а сервер отправляет другим. Push будет отклоняться с ошибкой 403.",
    );
  }
  if (!env.SESSION_SECRET) warnings.push("Нет SESSION_SECRET — вход в систему не работает");
  if (!env.TELEGRAM_WEBHOOK_SECRET) warnings.push("Нет TELEGRAM_WEBHOOK_SECRET — вебхук бота отключён");
  if (env.WHATSAPP_ENABLED && !env.GREEN_API_WEBHOOK_SECRET) {
    warnings.push(
      "WhatsApp включён, но нет GREEN_API_WEBHOOK_SECRET — вебхук закрыт, сообщения пациентов не дойдут",
    );
  }
  if (typeof db.knowledgeEntries === "number" && db.knowledgeEntries === 0) {
    warnings.push("База знаний пуста — ассистенту нечем отвечать про адрес, подготовку и условия");
  }

  if (process.env.ROUTER_AI_MODEL?.includes("opus")) {
    warnings.push(
      "ROUTER_AI_MODEL на хостинге указывает на Opus — он дороже Sonnet примерно втрое. " +
        "Уберите переменную, чтобы работало значение из кода.",
    );
  }

  return NextResponse.json({ ok: warnings.length === 0, env, push, models, db, warnings });
}
