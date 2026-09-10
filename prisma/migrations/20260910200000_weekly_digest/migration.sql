-- Еженедельная сводка владельцу.
--
-- Только добавление таблицы: ничего не удаляется, ничего не переименовывается,
-- существующие столбцы не меняются.
CREATE TABLE "weekly_digests" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "weekStart" TIMESTAMPTZ(3) NOT NULL,
    "label" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "byModel" BOOLEAN NOT NULL DEFAULT false,
    "hasBaseline" BOOLEAN NOT NULL DEFAULT false,
    "observations" JSONB NOT NULL,
    "metrics" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weekly_digests_pkey" PRIMARY KEY ("id")
);

-- Неделя уникальна на клинику: повторный прогон не заводит вторую сводку.
CREATE UNIQUE INDEX "weekly_digests_companyId_weekStart_key" ON "weekly_digests"("companyId", "weekStart");
CREATE INDEX "weekly_digests_companyId_weekStart_idx" ON "weekly_digests"("companyId", "weekStart");

ALTER TABLE "weekly_digests" ADD CONSTRAINT "weekly_digests_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
