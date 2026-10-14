-- Память разговора ассистента администратора: о ком шла речь. Только
-- добавление: одна необязательная колонка.

-- AlterTable
ALTER TABLE "ai_chat_messages" ADD COLUMN     "meta" JSONB;

