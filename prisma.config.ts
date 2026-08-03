import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * Конфиг Prisma CLI.
 *
 * datasource подставляем только когда DATABASE_URL реально задан. Причина:
 * `prisma generate` базу не трогает, а на сборке (фаза установки зависимостей
 * у хостинга) переменных окружения ещё нет — прежний env("DATABASE_URL")
 * бросал исключение и валил весь билд. Команды, которым база нужна
 * (migrate, db seed, studio), запускаются с окружением и получают url.
 */
const url = process.env.DATABASE_URL;
const shadowUrl = process.env.SHADOW_DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  ...(url
    ? { datasource: { url, ...(shadowUrl ? { shadowDatabaseUrl: shadowUrl } : {}) } }
    : {}),
});
