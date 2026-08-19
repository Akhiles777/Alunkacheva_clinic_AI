-- Сохранённые разговоры владельца с ИИ-аналитиком.
--
-- Раньше разбор жил до перезагрузки страницы: владелец задавал вопрос,
-- получал анализ и терял его. Каждый чат теперь своя задача — «выручка за
-- квартал», «загрузка кабинетов» — и к нему можно вернуться.
CREATE TYPE "AiChatRole" AS ENUM ('USER', 'ASSISTANT');

CREATE TABLE "ai_chats" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastMessageAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(3),
    CONSTRAINT "ai_chats_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ai_chat_messages" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "role" "AiChatRole" NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_chat_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_chats_companyId_userId_lastMessageAt_idx" ON "ai_chats"("companyId", "userId", "lastMessageAt");
CREATE INDEX "ai_chat_messages_chatId_createdAt_idx" ON "ai_chat_messages"("chatId", "createdAt");

ALTER TABLE "ai_chats" ADD CONSTRAINT "ai_chats_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_chats" ADD CONSTRAINT "ai_chats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "staff_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_chat_messages" ADD CONSTRAINT "ai_chat_messages_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "ai_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
