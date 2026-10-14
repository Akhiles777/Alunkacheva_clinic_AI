-- Школьная акция и школы-партнёры: акции, школы, привязки пациентов, бонусы.
--
-- Только добавление: четыре новые таблицы и два типа, существующие не меняются.

-- CreateEnum
CREATE TYPE "PartnerSource" AS ENUM ('ADMIN', 'AGENT');

-- CreateEnum
CREATE TYPE "PartnerBonusStatus" AS ENUM ('EARNED', 'REVERSED');

-- CreateTable
CREATE TABLE "promos" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "priceTotal" DECIMAL(12,2) NOT NULL,
    "priceRegular" DECIMAL(12,2) NOT NULL,
    "ageMin" INTEGER,
    "ageMax" INTEGER,
    "serviceIds" INTEGER[],
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "bonusAmount" DECIMAL(12,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "agentEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "promos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_schools" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "promoId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "reportToken" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "partner_schools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_attributions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "promoId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "conversationId" TEXT,
    "source" "PartnerSource" NOT NULL,
    "bonusAmountFrozen" DECIMAL(12,2) NOT NULL,
    "attributedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" TEXT,
    "isExtraChild" BOOLEAN NOT NULL DEFAULT false,
    "childNo" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT,
    "removedAt" TIMESTAMPTZ(3),
    "removedById" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "partner_attributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_bonuses" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "attributionId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "PartnerBonusStatus" NOT NULL,
    "triggeredByAppointmentId" TEXT NOT NULL,
    "earnedAt" TIMESTAMPTZ(3) NOT NULL,
    "reversedAt" TIMESTAMPTZ(3),
    "reverseReason" TEXT,

    CONSTRAINT "partner_bonuses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "promos_companyId_slug_key" ON "promos"("companyId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "partner_schools_reportToken_key" ON "partner_schools"("reportToken");

-- CreateIndex
CREATE INDEX "partner_schools_companyId_promoId_idx" ON "partner_schools"("companyId", "promoId");

-- CreateIndex
CREATE INDEX "partner_attributions_companyId_schoolId_idx" ON "partner_attributions"("companyId", "schoolId");

-- CreateIndex
CREATE INDEX "partner_attributions_companyId_promoId_idx" ON "partner_attributions"("companyId", "promoId");

-- CreateIndex
CREATE UNIQUE INDEX "partner_attributions_patientId_promoId_childNo_key" ON "partner_attributions"("patientId", "promoId", "childNo");

-- CreateIndex
CREATE UNIQUE INDEX "partner_bonuses_attributionId_key" ON "partner_bonuses"("attributionId");

-- CreateIndex
CREATE INDEX "partner_bonuses_companyId_schoolId_idx" ON "partner_bonuses"("companyId", "schoolId");

-- AddForeignKey
ALTER TABLE "promos" ADD CONSTRAINT "promos_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_schools" ADD CONSTRAINT "partner_schools_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_schools" ADD CONSTRAINT "partner_schools_promoId_fkey" FOREIGN KEY ("promoId") REFERENCES "promos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_attributions" ADD CONSTRAINT "partner_attributions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_attributions" ADD CONSTRAINT "partner_attributions_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "partner_schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_attributions" ADD CONSTRAINT "partner_attributions_promoId_fkey" FOREIGN KEY ("promoId") REFERENCES "promos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_attributions" ADD CONSTRAINT "partner_attributions_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_bonuses" ADD CONSTRAINT "partner_bonuses_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_bonuses" ADD CONSTRAINT "partner_bonuses_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "partner_schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_bonuses" ADD CONSTRAINT "partner_bonuses_attributionId_fkey" FOREIGN KEY ("attributionId") REFERENCES "partner_attributions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

