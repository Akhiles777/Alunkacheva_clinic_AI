-- Одна попытка агента ответить пациенту.
--
-- До этой таблицы сбои модели жили только в журнале процесса: «бот иногда
-- молчит» оставалось ощущением, а не числом. Строка пишется на каждую попытку,
-- включая повтор после таймаута. Персональных данных здесь нет (§7).
CREATE TYPE "AgentRunOutcome" AS ENUM (
  'OK', 'TIMEOUT', 'PROVIDER_ERROR', 'EMPTY_RESPONSE', 'ESCALATED', 'SUPPRESSED'
);

CREATE TABLE "agent_runs" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "messageId" TEXT,
  "triggeredAt" TIMESTAMPTZ(3) NOT NULL,
  "finishedAt" TIMESTAMPTZ(3),
  "latencyMs" INTEGER,
  "outcome" "AgentRunOutcome" NOT NULL,
  "escalationId" TEXT,
  "knowledgeEntryIds" TEXT[],
  "model" TEXT,
  "promptTokens" INTEGER,
  "completionTokens" INTEGER,
  "errorText" TEXT,
  "retryOf" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_runs_companyId_triggeredAt_idx" ON "agent_runs"("companyId", "triggeredAt");
CREATE INDEX "agent_runs_conversationId_idx" ON "agent_runs"("conversationId");
CREATE INDEX "agent_runs_outcome_triggeredAt_idx" ON "agent_runs"("outcome", "triggeredAt");

ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
