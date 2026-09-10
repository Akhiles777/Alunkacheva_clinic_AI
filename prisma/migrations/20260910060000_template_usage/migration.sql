-- Частота использования шаблонов: частые поднимаются в списке, мёртвые видно
-- в настройках. Только добавление колонок, обе со значением по умолчанию.
ALTER TABLE "message_templates"
  ADD COLUMN IF NOT EXISTS "useCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lastUsedAt" TIMESTAMPTZ(3);
