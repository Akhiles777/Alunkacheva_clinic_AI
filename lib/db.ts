import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Prisma 7 работает через driver adapter, поэтому пул создаём сами.
// Синглтон нужен из-за hot reload в dev: иначе каждый пересбор открывает
// новый пул и Postgres упирается в max_connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("Не задан DATABASE_URL — приложению нужна база");
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

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
