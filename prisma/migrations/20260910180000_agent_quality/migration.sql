-- Проверка качества ответов агента: вердикт модели и решение человека.
-- Только новая таблица.
-- CreateTable
CREATE TABLE "agent_quality_checks" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "agentRunId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "comment" TEXT NOT NULL,
    "checkedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMPTZ(3),
    "confirmed" BOOLEAN,

    CONSTRAINT "agent_quality_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_quality_checks_agentRunId_key" ON "agent_quality_checks"("agentRunId");

-- CreateIndex
CREATE INDEX "agent_quality_checks_companyId_checkedAt_idx" ON "agent_quality_checks"("companyId", "checkedAt");

-- CreateIndex
CREATE INDEX "agent_quality_checks_companyId_verdict_idx" ON "agent_quality_checks"("companyId", "verdict");

-- AddForeignKey
ALTER TABLE "agent_quality_checks" ADD CONSTRAINT "agent_quality_checks_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_quality_checks" ADD CONSTRAINT "agent_quality_checks_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_quality_checks" ADD CONSTRAINT "agent_quality_checks_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

