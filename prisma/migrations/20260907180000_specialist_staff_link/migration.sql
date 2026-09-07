-- Кому пересылать вопросы: ссылка на сотрудника вместо галочек.
--
-- Галочки «медицинские» и «деловые» дублировали то, что уже записано в
-- справочнике сотрудников и в визитах: кто какую услугу ведёт. Две правды об
-- одном — источник расхождений, а заполнять это руками незачем.
--
-- Написана руками: `prisma migrate dev` тянет в миграцию чужой дрейф схемы
-- (колонки inquiries.sourceConfidence и индекс course_purchases_serviceId_idx),
-- а удалять на боевой базе колонки с данными заодно с чужой миграцией нельзя.

ALTER TABLE "clinic_specialists" ADD COLUMN IF NOT EXISTS "staffId" TEXT;

ALTER TABLE "clinic_specialists" DROP COLUMN IF EXISTS "isDoctor";
ALTER TABLE "clinic_specialists" DROP COLUMN IF EXISTS "isManager";
ALTER TABLE "clinic_specialists" DROP COLUMN IF EXISTS "role";

CREATE INDEX IF NOT EXISTS "clinic_specialists_staffId_idx" ON "clinic_specialists"("staffId");

ALTER TABLE "clinic_specialists"
  ADD CONSTRAINT "clinic_specialists_staffId_fkey"
  FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
