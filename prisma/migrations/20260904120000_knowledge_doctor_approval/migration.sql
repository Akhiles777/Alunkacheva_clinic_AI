-- Медицинская справка утверждается врачом.
--
-- Агент отвечает медицинскими текстами дословно (§6, правило 1): что клиника
-- завела, то пациент и прочитает. Значит текст про подготовку и
-- противопоказания должен утвердить тот, кто за него отвечает, а не тот, кто
-- быстрее набрал его в переписке.
--
-- Отметка появляется только у новых записей, созданных из экрана «Пробелы»:
-- по умолчанию false, и ни одна уже заведённая запись не выключается.
ALTER TABLE "knowledge_entries"
  ADD COLUMN "needsDoctorApproval" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "approvedById" TEXT,
  ADD COLUMN "approvedAt" TIMESTAMPTZ(3);

ALTER TABLE "knowledge_entries"
  ADD CONSTRAINT "knowledge_entries_approvedById_fkey"
  FOREIGN KEY ("approvedById") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
