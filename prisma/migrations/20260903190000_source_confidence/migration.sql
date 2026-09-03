-- Откуда известен источник обращения.
--
-- Администраторы источник в YCLIENTS не заполняют: на боевых данных он не
-- проставлен ни у одного визита, и воронка «откуда пришёл пациент» мертва.
-- Вывод из переписки — факт (пациент написал в WhatsApp и записался после
-- разговора), но отличать его от проставленного руками обязательно: ручной
-- источник пересчёт трогать не должен никогда.
CREATE TYPE "SourceConfidence" AS ENUM ('MANUAL', 'DERIVED', 'UNKNOWN');

ALTER TABLE "appointments"
  ADD COLUMN "sourceConfidence" "SourceConfidence" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "sourceDerivedAt" TIMESTAMPTZ(3);

ALTER TABLE "inquiries"
  ADD COLUMN "sourceConfidence" "SourceConfidence" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "sourceDerivedAt" TIMESTAMPTZ(3);

-- Источник, уже проставленный до этой миграции, поставил человек: выводить
-- его было нечем. Помечаем как ручной, чтобы пересчёт его не переписал.
UPDATE "appointments" SET "sourceConfidence" = 'MANUAL' WHERE "sourceId" IS NOT NULL;
UPDATE "inquiries" SET "sourceConfidence" = 'MANUAL';
