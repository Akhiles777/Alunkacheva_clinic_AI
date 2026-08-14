-- Отметка о переносе переписки из мессенджера: тянем историю один раз на диалог.
ALTER TABLE "conversations" ADD COLUMN "historyImportedAt" TIMESTAMPTZ(3);
