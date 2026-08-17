-- Известна ли дата первого обращения. У перенесённых из YCLIENTS клиентов без
-- визитов её взять неоткуда, и день переноса нельзя считать притоком.
ALTER TABLE "patients" ADD COLUMN "firstSeenExact" BOOLEAN NOT NULL DEFAULT true;

-- Карточки, у которых дата первого обращения совпадает с датой создания строки
-- с точностью до минуты и визитов нет вовсе, — это и есть перенос базы.
UPDATE "patients" p
   SET "firstSeenExact" = false
 WHERE ABS(EXTRACT(EPOCH FROM (p."firstSeenAt" - p."createdAt"))) < 60
   AND NOT EXISTS (
     SELECT 1 FROM "appointments" a
      WHERE a."patientId" = p.id AND a."deletedAt" IS NULL
   );
