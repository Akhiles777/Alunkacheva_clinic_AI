-- Ответ на сообщение и правка после отправки.
--
-- Только добавление колонок, все необязательные: существующие сообщения
-- остаются как есть.
ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "replyToId" TEXT,
  ADD COLUMN IF NOT EXISTS "replyToPreview" TEXT,
  ADD COLUMN IF NOT EXISTS "editedAt" TIMESTAMPTZ(3);
