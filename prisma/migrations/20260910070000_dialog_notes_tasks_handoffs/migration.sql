-- Заметки по диалогу, отложенная отправка с напоминаниями и передача коллеге.
-- Только новые таблицы и типы: существующих данных не касается.
-- CreateEnum
CREATE TYPE "DialogTaskKind" AS ENUM ('SEND', 'REMIND');

-- CreateEnum
CREATE TYPE "DialogTaskStatus" AS ENUM ('PENDING', 'DONE', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "dialog_notes" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "authorId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "dialog_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dialog_tasks" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "kind" "DialogTaskKind" NOT NULL,
    "body" TEXT NOT NULL,
    "mediaIds" TEXT[],
    "replyToId" TEXT,
    "runAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "DialogTaskStatus" NOT NULL DEFAULT 'PENDING',
    "createdById" TEXT,
    "resultMessageId" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),

    CONSTRAINT "dialog_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dialog_handoffs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "fromId" TEXT,
    "toId" TEXT NOT NULL,
    "comment" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMPTZ(3),

    CONSTRAINT "dialog_handoffs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dialog_notes_conversationId_createdAt_idx" ON "dialog_notes"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "dialog_tasks_companyId_status_runAt_idx" ON "dialog_tasks"("companyId", "status", "runAt");

-- CreateIndex
CREATE INDEX "dialog_tasks_conversationId_status_idx" ON "dialog_tasks"("conversationId", "status");

-- CreateIndex
CREATE INDEX "dialog_handoffs_companyId_toId_createdAt_idx" ON "dialog_handoffs"("companyId", "toId", "createdAt");

-- CreateIndex
CREATE INDEX "dialog_handoffs_conversationId_createdAt_idx" ON "dialog_handoffs"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "dialog_notes" ADD CONSTRAINT "dialog_notes_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dialog_notes" ADD CONSTRAINT "dialog_notes_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dialog_notes" ADD CONSTRAINT "dialog_notes_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dialog_tasks" ADD CONSTRAINT "dialog_tasks_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dialog_tasks" ADD CONSTRAINT "dialog_tasks_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dialog_tasks" ADD CONSTRAINT "dialog_tasks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dialog_handoffs" ADD CONSTRAINT "dialog_handoffs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dialog_handoffs" ADD CONSTRAINT "dialog_handoffs_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dialog_handoffs" ADD CONSTRAINT "dialog_handoffs_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dialog_handoffs" ADD CONSTRAINT "dialog_handoffs_toId_fkey" FOREIGN KEY ("toId") REFERENCES "staff_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

