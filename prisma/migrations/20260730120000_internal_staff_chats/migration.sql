-- CreateEnum
CREATE TYPE "InternalChatKind" AS ENUM ('GENERAL', 'DIRECT');

-- CreateEnum
CREATE TYPE "InternalChatMessageKind" AS ENUM ('TEXT', 'VOICE', 'SYSTEM');

-- CreateTable
CREATE TABLE "internal_chat_rooms" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" "InternalChatKind" NOT NULL,
    "title" TEXT,
    "directKey" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "internal_chat_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "internal_chat_participants" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "staffUserId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMPTZ(3),
    "mutedAt" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "internal_chat_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "internal_chat_messages" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "kind" "InternalChatMessageKind" NOT NULL DEFAULT 'TEXT',
    "body" TEXT NOT NULL DEFAULT '',
    "attachments" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),
    "deletedById" TEXT,

    CONSTRAINT "internal_chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "internal_chat_rooms_companyId_kind_directKey_key" ON "internal_chat_rooms"("companyId", "kind", "directKey");

-- CreateIndex
CREATE INDEX "internal_chat_rooms_companyId_kind_updatedAt_idx" ON "internal_chat_rooms"("companyId", "kind", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "internal_chat_participants_roomId_staffUserId_key" ON "internal_chat_participants"("roomId", "staffUserId");

-- CreateIndex
CREATE INDEX "internal_chat_participants_companyId_staffUserId_deletedAt_idx" ON "internal_chat_participants"("companyId", "staffUserId", "deletedAt");

-- CreateIndex
CREATE INDEX "internal_chat_messages_roomId_createdAt_idx" ON "internal_chat_messages"("roomId", "createdAt");

-- CreateIndex
CREATE INDEX "internal_chat_messages_companyId_authorId_createdAt_idx" ON "internal_chat_messages"("companyId", "authorId", "createdAt");

-- AddForeignKey
ALTER TABLE "internal_chat_rooms" ADD CONSTRAINT "internal_chat_rooms_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_chat_participants" ADD CONSTRAINT "internal_chat_participants_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_chat_participants" ADD CONSTRAINT "internal_chat_participants_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "internal_chat_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_chat_participants" ADD CONSTRAINT "internal_chat_participants_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "staff_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_chat_messages" ADD CONSTRAINT "internal_chat_messages_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_chat_messages" ADD CONSTRAINT "internal_chat_messages_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "internal_chat_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_chat_messages" ADD CONSTRAINT "internal_chat_messages_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "staff_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
