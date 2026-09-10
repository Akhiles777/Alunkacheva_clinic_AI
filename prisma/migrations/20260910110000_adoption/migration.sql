-- Измерение перехода в систему: чем пользуются и что осталось невостребованным,
-- сообщения о проблемах, признак «ушло из платформы».
-- Только добавление: колонка со значением по умолчанию и две новые таблицы.
-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "viaPlatform" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "feature_use" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "day" TIMESTAMPTZ(3) NOT NULL,
    "feature" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "feature_use_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "problem_reports" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "authorId" TEXT,
    "text" TEXT NOT NULL,
    "screen" TEXT,
    "lastError" TEXT,
    "build" TEXT,
    "resolvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "problem_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feature_use_companyId_day_idx" ON "feature_use"("companyId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "feature_use_companyId_day_feature_key" ON "feature_use"("companyId", "day", "feature");

-- CreateIndex
CREATE INDEX "problem_reports_companyId_createdAt_idx" ON "problem_reports"("companyId", "createdAt");

-- AddForeignKey
ALTER TABLE "feature_use" ADD CONSTRAINT "feature_use_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "problem_reports" ADD CONSTRAINT "problem_reports_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "problem_reports" ADD CONSTRAINT "problem_reports_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

