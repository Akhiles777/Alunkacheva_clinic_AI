-- Локальные визиты больше не выдумывают yclientsRecordId: сгенерированные
-- номера сталкивались бы с настоящими при выгрузке из YCLIENTS и
-- перезаписывали чужие записи. NULL означает «у нас есть, туда не отправлен».
ALTER TABLE "appointments" ALTER COLUMN "yclientsRecordId" DROP NOT NULL;

-- Состояние обратной записи. Без него сбой отправки невидим: визит есть у
-- нас, в YCLIENTS его нет, и слот обе стороны считают свободным.
CREATE TYPE "ApptSyncState" AS ENUM ('LOCAL_ONLY', 'PENDING', 'SYNCED', 'CONFLICT', 'FAILED');
ALTER TABLE "appointments" ADD COLUMN "syncState" "ApptSyncState" NOT NULL DEFAULT 'LOCAL_ONLY';
ALTER TABLE "appointments" ADD COLUMN "syncError" TEXT;
ALTER TABLE "appointments" ADD COLUMN "syncAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "appointments" ADD COLUMN "lastSyncAt" TIMESTAMPTZ(3);

-- Визиты, приехавшие из YCLIENTS, уже синхронизированы по определению.
UPDATE "appointments" SET "syncState" = 'SYNCED' WHERE "yclientsRecordId" IS NOT NULL;
