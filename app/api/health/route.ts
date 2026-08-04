import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

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
  if (!env.VAPID_PRIVATE || !env.VAPID_PUBLIC) warnings.push("Нет ключей VAPID — push-уведомления не отправляются");
  if (!env.SESSION_SECRET) warnings.push("Нет SESSION_SECRET — вход в систему не работает");
  if (!env.TELEGRAM_WEBHOOK_SECRET) warnings.push("Нет TELEGRAM_WEBHOOK_SECRET — вебхук бота отключён");
  if (typeof db.knowledgeEntries === "number" && db.knowledgeEntries === 0) {
    warnings.push("База знаний пуста — ассистенту нечем отвечать про адрес, подготовку и условия");
  }

  if (process.env.ROUTER_AI_MODEL?.includes("opus")) {
    warnings.push(
      "ROUTER_AI_MODEL на хостинге указывает на Opus — он дороже Sonnet примерно втрое. " +
        "Уберите переменную, чтобы работало значение из кода.",
    );
  }

  return NextResponse.json({ ok: warnings.length === 0, env, models, db, warnings });
}
