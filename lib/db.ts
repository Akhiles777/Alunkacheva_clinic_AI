import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Клиент Prisma создаётся лениво — при первом обращении, а не при импорте.
 *
 * Next на шаге «Collecting page data» импортирует все страницы, а базы на
 * сборке нет. Если создавать пул (и требовать DATABASE_URL) прямо в теле
 * модуля, сборка падает ещё до деплоя. Проверка переменной осталась, но
 * срабатывает на первом запросе — там она уместна и сообщение видно в логах.
 *
 * Синглтон в globalThis нужен и в dev (hot reload иначе плодит пулы, и Postgres
 * упирается в max_connections), и в проде (инстанс переиспользует соединения
 * между вызовами).
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Строка подключения. Основное имя — DATABASE_URL; POSTGRES_URL и
 * PRISMA_DATABASE_URL подхватываем запасными, потому что управляемые базы
 * (в том числе Prisma Postgres на Vercel) подставляют в окружение именно их, и
 * без этого приложение падало бы при живой и настроенной базе.
 * Берём только прямое подключение: адаптеру нужен постgres-протокол.
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
      // На serverless каждый инстанс держит свой пул, и десяток холодных
      // стартов легко упирается в max_connections базы. Держим пул узким и
      // отпускаем простаивающие соединения быстро; для постоянного сервера
      // предел поднимается через DATABASE_POOL_MAX.
      max: Number(process.env.DATABASE_POOL_MAX ?? 5),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
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
