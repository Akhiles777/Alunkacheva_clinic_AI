/**
 * Готов ли Instagram Direct — цепочка целиком, до первой ошибки.
 *
 * Половина настройки канала живёт в переменных окружения, половина в базе, а
 * остальное — в кабинете Meta, куда у нас доступа нет. Поэтому скрипт называет
 * каждое звено словами: что задано у нас, что мы видим из переписок и что
 * остаётся проверить глазами.
 *
 * Ничего не меняет и никому не пишет: только читает.
 *
 *   npx tsx scripts/instagram-check.ts
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { INSTAGRAM_PROVIDER, isInstagramEnabled, windowOpen } from "../lib/integrations/instagram/config";
import { absoluteUrl } from "../lib/server/app-url";

const WHEN = (d: Date) =>
  new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(d);

const mark = (ok: boolean) => (ok ? "есть" : "НЕТ");

async function main() {
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  console.log(`клиника: ${company.name}\n`);

  const token = await prisma.credential.count({
    where: { companyId: company.id, provider: INSTAGRAM_PROVIDER, keyName: "page_token" },
  });

  console.log("── ЧТО ЗАДАНО У НАС");
  console.log(`  токен страницы в «Интеграциях»: ${mark(token > 0)}`);
  console.log(`  INSTAGRAM_APP_SECRET: ${mark(Boolean(process.env.INSTAGRAM_APP_SECRET?.trim()))}`);
  console.log(`  INSTAGRAM_VERIFY_TOKEN: ${mark(Boolean(process.env.INSTAGRAM_VERIFY_TOKEN?.trim()))}`);
  console.log(`  INSTAGRAM_ENABLED: ${isInstagramEnabled() ? "true" : "false — вебхук отвечает отказом"}`);
  console.log(`  адрес для кабинета Meta: ${absoluteUrl("/api/webhooks/instagram") || "не задан APP_URL"}`);

  const convs = await prisma.conversation.findMany({
    where: { companyId: company.id, channel: "INSTAGRAM" },
    orderBy: { lastMessageAt: "desc" },
    take: 5,
    select: {
      id: true,
      externalUserId: true,
      lastMessageAt: true,
      patientId: true,
      _count: { select: { messages: true } },
    },
  });

  console.log("\n── ПЕРЕПИСКИ");
  if (convs.length === 0) {
    console.log("  Ни одной переписки из Instagram нет.");
    console.log("  Пока вебхук не подключён в кабинете Meta, входящих не будет вовсе:");
    console.log("  сообщения приходят только событием, опрашивать Instagram нельзя.");
  }
  for (const c of convs) {
    const last = await prisma.message.findFirst({
      where: { conversationId: c.id, direction: "IN", deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    console.log(`  ${c.externalUserId} · сообщений ${c._count.messages} · последнее ${WHEN(c.lastMessageAt)}`);
    console.log(
      `    карточка: ${c.patientId ? "привязана" : "нет (в Instagram телефона нет — пока пациент его не назвал)"}`,
    );
    console.log(
      `    окно ответа: ${windowOpen(last?.createdAt ?? null) ? "открыто" : "ЗАКРЫТО — свободным текстом писать нельзя"}`,
    );
  }

  console.log("\n── ЧТО ПРОВЕРИТЬ В КАБИНЕТЕ META");
  console.log("  1. Аккаунт Instagram — Business и привязан к странице Facebook.");
  console.log("  2. Приложение прошло review на переписку (instagram_manage_messages).");
  console.log("     Без review пишут только тестовые пользователи — это ограничение Meta, не наше.");
  console.log("  3. Вебхук указывает на адрес выше, поле messages включено,");
  console.log("     слово проверки совпадает с INSTAGRAM_VERIFY_TOKEN.");
  console.log("  4. В настройках аккаунта разрешён доступ к сообщениям для приложения.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
