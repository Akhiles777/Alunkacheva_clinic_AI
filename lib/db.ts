import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Клиент Prisma создаётся лениво — при первом обращении, а не при импорте.
 *
 * Next на шаге «Collecting page data» импортирует все страницы, а базы на
 * сборке нет. Если создавать пул (и требовать DATABASE_URL) прямо в теле
 * модуля, сборка падает ещё до деплоя.
 *
 * Размер пула — критичная настройка, а не мелочь. На serverless каждый вызов
 * функции живёт в своём экземпляре со своим пулом, и экземпляров одновременно
 * бывают десятки. Пул в 5 соединений на экземпляр упирался в предел базы
 * (50 соединений): запросы начинали получать «too many connections», причём
 * первыми страдали не страницы, а фоновые шаги — отправка push переставала
 * находить подписки и молча падала, хотя само уведомление уже записалось.
 * Поэтому на serverless держим ровно одно соединение на экземпляр: вызов
 * всё равно обрабатывает один запрос за раз.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Строка подключения. Основное имя — DATABASE_URL; POSTGRES_URL и
 * PRISMA_DATABASE_URL подхватываем запасными, потому что управляемые базы
 * (в том числе Prisma Postgres на Vercel) подставляют в окружение именно их.
 */
export function resolveDatabaseUrl(): string | null {
  const candidates = [
    process.env.DATABASE_URL,
    process.env.POSTGRES_URL,
    process.env.PRISMA_DATABASE_URL,
  ];
  for (const value of candidates) {
    if (value && /^postgres(ql)?:\/\//.test(value)) return value;
  }
  return null;
}

/** Признак бессерверного окружения: там каждый вызов — отдельный экземпляр. */
function isServerless(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

function poolSize(): number {
  const fromEnv = Number(process.env.DATABASE_POOL_MAX);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return isServerless() ? 1 : 5;
}

function createClient(): PrismaClient {
  const connectionString = resolveDatabaseUrl();
  if (!connectionString) {
    throw new Error(
      "Не задана строка подключения к базе: ожидается DATABASE_URL (или POSTGRES_URL / PRISMA_DATABASE_URL)",
    );
  }
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      max: poolSize(),
      // Простаивающее соединение освобождаем быстро: на serverless экземпляр
      // может жить минутами после ответа и всё это время держать место в
      // лимите базы, не делая ничего полезного.
      idleTimeoutMillis: isServerless() ? 3_000 : 10_000,
      connectionTimeoutMillis: 10_000,
      // Пул закрывается, когда все соединения простаивают: экземпляр,
      // «замороженный» между вызовами, не удерживает подключение.
      allowExitOnIdle: isServerless(),
    }),
  });
}

function getClient(): PrismaClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createClient();
  }
  return globalForPrisma.prisma;
}

export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getClient();
    const value = Reflect.get(client, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
