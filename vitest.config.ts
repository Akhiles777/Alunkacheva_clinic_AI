import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Тесты видят те же пути, что и приложение.
 *
 * Без алиаса «@/» любой модуль, который импортирует «@/lib/...», в тестах не
 * загружался: приходилось либо переписывать импорты на относительные, либо
 * выносить проверяемый код в отдельный файл ради самой возможности его
 * проверить. Из-за этого часть логики оставалась без тестов не по существу, а
 * из-за настройки.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
    exclude: ["node_modules", ".next", "generated"],
  },
});
