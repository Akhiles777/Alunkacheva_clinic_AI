-- Откуда известен источник ПЕРВОГО обращения пациента.
--
-- Только добавление: ни одна существующая колонка не меняется. У всех
-- имеющихся карточек значение UNKNOWN — ровно то, что о них известно сейчас.
-- Ручную отметку администратора (MANUAL) пересчёт после этого не трогает.
ALTER TABLE "patients"
  ADD COLUMN IF NOT EXISTS "sourceConfidence" "SourceConfidence" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS "sourceDerivedAt" TIMESTAMPTZ(3);
