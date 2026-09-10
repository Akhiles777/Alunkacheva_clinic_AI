-- Тренировочные переписки: наружу не уходят и в метрики не идут.
-- Только добавление колонки со значением по умолчанию.
ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "isPractice" BOOLEAN NOT NULL DEFAULT false;
