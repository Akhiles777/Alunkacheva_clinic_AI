/**
 * Готов ли Instagram Direct — цепочка целиком, до первой ошибки.
 *
 * Ключи клиники живут в базе («Интеграции»), адрес прокси и его секрет — в
 * окружении, остальное — в кабинете Meta и на Vercel, куда у нас доступа нет.
 * Поэтому скрипт называет каждое звено словами: что задано у нас, проходит ли
 * связь через прокси, что видно из переписок и что проверить глазами.
 *
 * Ничего не меняет и никому не пишет. Единственные запросы наружу — проверка
 * прокси: к Meta без токена и к нашему же вебхуку через прокси.
 *
 *   npx tsx scripts/instagram-check.ts
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import {
  INSTAGRAM_PROVIDER,
  graphBase,
  isInstagramEnabled,
  proxySecret,
  proxyWebhookUrl,
  windowOpen,
} from "../lib/integrations/instagram/config";
import { checkProxy } from "../lib/integrations/instagram/proxy-health";

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

  const keys = await prisma.credential.findMany({
    where: { companyId: company.id, provider: INSTAGRAM_PROVIDER },
    select: { keyName: true },
  });
  const has = (k: string) => keys.some((r) => r.keyName === k);

  console.log("── ЧТО ЗАДАНО У НАС");
  console.log(`  токен страницы в «Интеграциях»: ${mark(has("page_token"))}`);
  console.log(`  секрет приложения в «Интеграциях»: ${mark(has("app_secret"))}`);
  console.log(`  слово проверки в «Интеграциях»: ${mark(has("verify_token"))}`);
  console.log(`  INSTAGRAM_GRAPH_BASE: ${graphBase() ?? "НЕТ"}`);
  console.log(`  INSTAGRAM_PROXY_SECRET: ${mark(Boolean(proxySecret()))}`);
  console.log(`  INSTAGRAM_ENABLED: ${isInstagramEnabled() ? "true" : "false — вебхук отвечает отказом"}`);
  console.log(`  адрес для кабинета Meta (прокси): ${proxyWebhookUrl() ?? "не собрать — нет адреса прокси"}`);

  console.log("\n── СВЯЗЬ ЧЕРЕЗ ПРОКСИ");
  const probe = await checkProxy();
  console.log(`  мы → прокси → Meta: ${probe.outbound ?? "работает"}`);
  console.log(`  прокси → сервер клиники: ${probe.inbound ?? "работает"}`);

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
  console.log("  3. Вебхук указывает на адрес ПРОКСИ выше, поле messages включено,");
  console.log("     слово проверки совпадает с заведённым в «Интеграциях».");
  console.log("  4. В настройках аккаунта разрешён доступ к сообщениям для приложения.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
