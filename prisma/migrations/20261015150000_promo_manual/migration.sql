-- Акция: состав позициями, участники без школы, ручные отметки «прошёл» и
-- ручной бонус. Данные не теряются: две колонки перестают быть обязательными,
-- остальное — новые колонки со значениями по умолчанию.

-- AlterTable
ALTER TABLE "promos" ADD COLUMN     "items" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "partner_attributions" ADD COLUMN     "completedAt" TIMESTAMPTZ(3),
ADD COLUMN     "completedById" TEXT,
ALTER COLUMN "schoolId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "partner_bonuses" ADD COLUMN     "manual" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "setById" TEXT,
ALTER COLUMN "triggeredByAppointmentId" DROP NOT NULL;

