-- Школьная акция «Школьный ресурс»: метка WhatsApp, услуги по названию, привязка
-- по улике в переписке на проверку человеком, бонус по визиту. Только добавления.

-- CreateEnum
CREATE TYPE "AttributionConfidence" AS ENUM ('MARKER', 'AI_EVIDENCE', 'MANUAL');

-- CreateEnum
CREATE TYPE "AttributionReview" AS ENUM ('CONFIRMED', 'REVIEW', 'REJECTED');

-- CreateEnum
CREATE TYPE "AiCheckResult" AS ENUM ('ATTRIBUTED', 'NOT_FROM_SCHOOL', 'UNCLEAR', 'REJECTED_BY_VERIFIER', 'MODEL_ERROR');

-- AlterTable
ALTER TABLE "partner_attributions" ADD COLUMN     "confidence" "AttributionConfidence" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "evidenceMessageId" TEXT,
ADD COLUMN     "evidenceQuote" TEXT,
ADD COLUMN     "returningPatient" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reviewStatus" "AttributionReview" NOT NULL DEFAULT 'CONFIRMED',
ADD COLUMN     "reviewedAt" TIMESTAMPTZ(3),
ADD COLUMN     "reviewedById" TEXT;

-- AlterTable
ALTER TABLE "partner_bonuses" ADD COLUMN     "triggeredByVisitKey" TEXT;

-- AlterTable
ALTER TABLE "partner_schools" ADD COLUMN     "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "promos" ADD COLUMN     "aiReviewEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "excludedServiceIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "serviceKeywords" TEXT[] DEFAULT ARRAY['школьн']::TEXT[],
ADD COLUMN     "serviceSnapshot" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "waMarker" TEXT NOT NULL DEFAULT '[ШК]',
ADD COLUMN     "waPhone" TEXT;

-- CreateTable
CREATE TABLE "ai_attribution_checks" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "promoId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "result" "AiCheckResult" NOT NULL,
    "evidenceMessageId" TEXT,
    "evidenceQuote" TEXT,
    "reason" TEXT,
    "model" TEXT NOT NULL,
    "checkedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_attribution_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_attribution_checks_promoId_patientId_idx" ON "ai_attribution_checks"("promoId", "patientId");

-- CreateIndex
CREATE INDEX "ai_attribution_checks_companyId_checkedAt_idx" ON "ai_attribution_checks"("companyId", "checkedAt");

-- AddForeignKey
ALTER TABLE "ai_attribution_checks" ADD CONSTRAINT "ai_attribution_checks_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_attribution_checks" ADD CONSTRAINT "ai_attribution_checks_promoId_fkey" FOREIGN KEY ("promoId") REFERENCES "promos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

