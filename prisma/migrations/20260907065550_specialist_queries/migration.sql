-- Вопрос врачу и руководству клиники.
--
-- Только новые таблицы. Prisma положила сюда ещё два чужих изменения —
-- удаление колонок inquiries.sourceConfidence/sourceDerivedAt и индекса
-- course_purchases_serviceId_idx. Это расхождение схемы с историей миграций
-- появилось раньше и к этой задаче отношения не имеет; удалять на боевой базе
-- колонки с данными заодно с чужой миграцией нельзя.

-- CreateEnum
CREATE TYPE "SpecialistQueryKind" AS ENUM ('MEDICAL', 'MANAGEMENT');

-- CreateEnum
CREATE TYPE "SpecialistQueryStatus" AS ENUM ('SENT', 'ANSWERED', 'DECLINED', 'STALE');

-- CreateTable
CREATE TABLE "clinic_specialists" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "isDoctor" BOOLEAN NOT NULL DEFAULT false,
    "isManager" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "role" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "clinic_specialists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialist_queries" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "patientId" TEXT,
    "specialistId" TEXT NOT NULL,
    "kind" "SpecialistQueryKind" NOT NULL,
    "status" "SpecialistQueryStatus" NOT NULL DEFAULT 'SENT',
    "ref" INTEGER NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT,
    "relayed" TEXT,
    "askedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMPTZ(3),
    "relayedAt" TIMESTAMPTZ(3),

    CONSTRAINT "specialist_queries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clinic_specialists_companyId_isActive_idx" ON "clinic_specialists"("companyId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "clinic_specialists_companyId_phone_key" ON "clinic_specialists"("companyId", "phone");

-- CreateIndex
CREATE INDEX "specialist_queries_companyId_status_idx" ON "specialist_queries"("companyId", "status");

-- CreateIndex
CREATE INDEX "specialist_queries_conversationId_askedAt_idx" ON "specialist_queries"("conversationId", "askedAt");

-- CreateIndex
CREATE UNIQUE INDEX "specialist_queries_companyId_ref_key" ON "specialist_queries"("companyId", "ref");

-- AddForeignKey
ALTER TABLE "clinic_specialists" ADD CONSTRAINT "clinic_specialists_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialist_queries" ADD CONSTRAINT "specialist_queries_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialist_queries" ADD CONSTRAINT "specialist_queries_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialist_queries" ADD CONSTRAINT "specialist_queries_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialist_queries" ADD CONSTRAINT "specialist_queries_specialistId_fkey" FOREIGN KEY ("specialistId") REFERENCES "clinic_specialists"("id") ON DELETE CASCADE ON UPDATE CASCADE;
