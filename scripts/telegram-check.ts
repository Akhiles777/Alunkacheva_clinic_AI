/**
 * Почему бот не отвечает в Telegram.
 *
 * Молчание в мессенджере выглядит одинаково при пяти разных причинах: не
 * зарегистрирован вебхук, не совпал секрет, выключен ассистент, диалог на
 * паузе после ответа человека, отправка не прошла. Гадать по коду тут нельзя —
 * каждая причина требует своего действия, и различает их только состояние.
 *
 * Скрипт проходит цепочку сверху вниз и на каждом шаге отвечает «да» или
 * «нет»: от того, знает ли Telegram наш адрес, до того, ушло ли последнее
 * сообщение бота.
 *
 *   npx tsx scripts/telegram-check.ts
 */
import "dotenv/config";
import { prisma } from "../lib/db";

const API = "https://api.telegram.org";

async function tg<T>(method: string): Promise<T | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return null;
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json()) as { ok: boolean; result?: T };
    return json.ok ? (json.result ?? null) : null;
  } catch {
    return null;
  }
}

const when = (at: Date | null | undefined) =>
  at ? at.toISOString().slice(0, 16).replace("T", " ") : "никогда";

async function main() {
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  console.log(`клиника: ${company.name}\n`);

  // ── 1. ключи
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  console.log("── КЛЮЧИ");
  console.log(`  TELEGRAM_BOT_TOKEN:      ${token ? "задан" : "НЕ ЗАДАН — бот молчит всегда"}`);
  console.log(
    `  TELEGRAM_WEBHOOK_SECRET: ${secret ? "задан" : "НЕ ЗАДАН — вебхук отключён (503 на каждый update)"}`,
  );
  if (!token) {
    console.log("\n  Без токена дальше проверять нечего.");
    return;
  }

  // ── 2. знает ли Telegram, куда слать
  const me = await tg<{ username?: string }>("getMe");
  console.log(`  бот: ${me?.username ? `@${me.username}` : "токен не принят Telegram"}`);

  const info = await tg<{
    url?: string;
    pending_update_count?: number;
    last_error_date?: number;
    last_error_message?: string;
    max_connections?: number;
  }>("getWebhookInfo");

  console.log("\n── ВЕБХУК В TELEGRAM");
  if (!info) {
    /**
     * getMe прошёл, а getWebhookInfo нет — значит токен верный, а связь с
     * api.telegram.org рвётся. Это же и есть причина недоставленных ответов:
     * входящие идут (Telegram стучится к нам сам), исходящие не уходят.
     */
    console.log("  ✗ ответ не получен, хотя токен принят.");
    console.log("    Значит рвётся ИСХОДЯЩАЯ связь с api.telegram.org с этого сервера.");
    console.log("    Проверить руками:");
    console.log("      curl -s -m 10 https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo");
  } else if (!info.url) {
    console.log("  ✗ АДРЕС НЕ ЗАРЕГИСТРИРОВАН. Telegram не знает, куда слать сообщения.");
    console.log("    Это и есть молчание бота. Зарегистрировать:");
    console.log(
      "      curl -s 'https://api.telegram.org/bot<ТОКЕН>/setWebhook' \\\n" +
        "        -d url=https://alunkachevaclinic.ru/api/webhooks/telegram \\\n" +
        "        -d secret_token=<TELEGRAM_WEBHOOK_SECRET>",
    );
  } else {
    console.log(`  адрес: ${info.url}`);
    console.log(`  очередь необработанных: ${info.pending_update_count ?? 0}`);
    if (info.last_error_date) {
      const at = new Date(info.last_error_date * 1000);
      console.log(`  ✗ последняя ошибка доставки: ${when(at)} — ${info.last_error_message}`);
      console.log("    Telegram стучится, а мы не принимаем. Чаще всего — несовпадение секрета.");
    } else {
      console.log("  ✓ ошибок доставки Telegram не фиксировал");
    }
  }

  // ── 3. доходят ли update-ы до нас
  const events = await prisma.webhookEvent.findMany({
    where: { companyId: company.id, provider: "TELEGRAM" },
    orderBy: { receivedAt: "desc" },
    take: 5,
    select: { receivedAt: true, eventType: true },
  });
  const eventCount = await prisma.webhookEvent.count({
    where: { companyId: company.id, provider: "TELEGRAM" },
  });
  console.log("\n── ДОХОДЯТ ЛИ ДО НАС");
  console.log(`  принято update-ов всего: ${eventCount}`);
  if (events.length === 0) {
    console.log("  ✗ НИ ОДНОГО. Сообщения до приложения не доходят — смотрите шаг выше.");
  } else {
    console.log(`  последние: ${events.map((e) => `${when(e.receivedAt)} (${e.eventType})`).join(", ")}`);
  }

  // ── 4. что с диалогами
  const convs = await prisma.conversation.findMany({
    where: { companyId: company.id, channel: "TELEGRAM", deletedAt: null },
    orderBy: { lastMessageAt: "desc" },
    take: 5,
    select: {
      id: true,
      externalUserId: true,
      status: true,
      botPausedUntil: true,
      lastMessageAt: true,
      lastPatientMessageAt: true,
      escalations: { where: { status: { not: "RESOLVED" } }, select: { reason: true }, take: 1 },
      messages: {
        where: { deletedAt: null, isDraft: false },
        orderBy: { createdAt: "desc" },
        take: 4,
        select: {
          direction: true,
          authorType: true,
          body: true,
          status: true,
          failureReason: true,
          createdAt: true,
        },
      },
    },
  });

  /**
   * Доставка исходящих — главный вопрос, если update-ы доходят. Бот может
   * отвечать исправно, а пациент не получать ничего.
   */
  const outbound = await prisma.message.groupBy({
    by: ["status"],
    where: {
      companyId: company.id,
      channel: "TELEGRAM",
      direction: "OUT",
      deletedAt: null,
      createdAt: { gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
    },
    _count: { _all: true },
  });
  console.log("\n── ОТПРАВКА ОТВЕТОВ (30 дней)");
  if (outbound.length === 0) {
    console.log("  бот ничего не отправлял");
  } else {
    for (const r of outbound) console.log(`  ${r.status.padEnd(10)} ${r._count._all}`);
    const failed = outbound.find((r) => r.status === "FAILED")?._count._all ?? 0;
    const sent = outbound.find((r) => r.status === "SENT")?._count._all ?? 0;
    if (failed > 0) {
      console.log(
        `  ✗ не доставлено ${failed} из ${failed + sent}: бот отвечал, пациент не получил.`,
      );
      const reasons = await prisma.message.findMany({
        where: {
          companyId: company.id,
          channel: "TELEGRAM",
          direction: "OUT",
          status: "FAILED",
          failureReason: { not: null },
        },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { createdAt: true, failureReason: true },
      });
      if (reasons.length === 0) {
        console.log("    причины не записаны — они появятся у сообщений после этого обновления");
      } else {
        for (const r of reasons) console.log(`    ${when(r.createdAt)} — ${r.failureReason}`);
      }
    }
  }

  console.log("\n── ДИАЛОГИ В TELEGRAM");
  if (convs.length === 0) {
    console.log("  диалогов нет");
  }
  const now = new Date();
  for (const c of convs) {
    const paused = c.botPausedUntil && c.botPausedUntil > now;
    console.log(`\n  чат ${c.externalUserId} · статус ${c.status} · последнее ${when(c.lastMessageAt)}`);
    if (paused) {
      console.log(`    ✗ АГЕНТ НА ПАУЗЕ до ${when(c.botPausedUntil)} — отвечал человек, бот молчит`);
    }
    if (c.escalations.length > 0) {
      console.log(`    ✗ открытая эскалация (${c.escalations[0].reason}) — диалог числится за человеком`);
    }
    for (const m of [...c.messages].reverse()) {
      const who = m.direction === "IN" ? "пациент" : m.authorType === "BOT" ? "бот" : "сотрудник";
      const mark =
        m.direction === "OUT"
          ? m.status === "SENT"
            ? " ✓доставлено"
            : ` ✗${m.status}${m.failureReason ? ` (${m.failureReason})` : ""}`
          : "";
      console.log(`    ${when(m.createdAt)} ${who}: ${m.body.slice(0, 70).replace(/\s+/g, " ")}${mark}`);
    }
  }

  // ── 5. режим ассистента
  const setting = await prisma.setting.findUnique({
    where: { companyId_key: { companyId: company.id, key: "assistant" } },
    select: { value: true },
  });
  const mode =
    (setting?.value as { assistant?: { mode?: string } } | null)?.assistant?.mode ?? "on";
  console.log("\n── РЕЖИМ АССИСТЕНТА");
  console.log(`  ${mode}`);
  if (mode === "off") {
    console.log("  ✗ ВЫКЛЮЧЕН: на любое сообщение заводится эскалация, ответа пациенту нет.");
  } else if (mode === "drafts") {
    console.log(
      "  только черновики: пациент получает «передал администратору», сам агент не отвечает.",
    );
  }

  // ── 6. журнал попыток
  const runs = await prisma.agentRun.groupBy({
    by: ["outcome"],
    where: { companyId: company.id },
    _count: { _all: true },
  });
  console.log("\n── ЖУРНАЛ ПОПЫТОК АГЕНТА");
  if (runs.length === 0) {
    console.log("  пуст: агент не пытался ответить ни разу с момента выката журнала");
  } else {
    for (const r of runs) console.log(`  ${r.outcome.padEnd(16)} ${r._count._all}`);
  }

  console.log(
    "\nВ «Диалогах» Telegram не показывается намеренно (решение заказчика): канал\n" +
      "используется для проверок и мешал бы видеть обращения из WhatsApp. Push по нему\n" +
      "тоже не уходит. На работу самого бота это не влияет — он отвечает в чат.",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
