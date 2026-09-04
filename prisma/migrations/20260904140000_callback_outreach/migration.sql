-- Обращение из очереди «Кому позвонить».
--
-- Без этой отметки нельзя честно ответить, работает ли список: запись,
-- появившаяся у пациента через два дня после звонка, — заслуга очереди, а
-- запись человека, которому никто не звонил, — нет. Приписывать себе все
-- записи подряд значит мерить не список, а поток.
CREATE TYPE "CallbackKind" AS ENUM ('COURSE_STALLED', 'COURSE_FINISHING', 'NO_SHOW', 'SLEEPING');

CREATE TABLE "callback_outreaches" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "kind" "CallbackKind" NOT NULL,
    "basis" TEXT NOT NULL,
    "money" DECIMAL(12,2),
    "staffUserId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "callback_outreaches_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "callback_outreaches_companyId_createdAt_idx" ON "callback_outreaches"("companyId", "createdAt");
CREATE INDEX "callback_outreaches_companyId_patientId_createdAt_idx" ON "callback_outreaches"("companyId", "patientId", "createdAt");

ALTER TABLE "callback_outreaches" ADD CONSTRAINT "callback_outreaches_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "callback_outreaches" ADD CONSTRAINT "callback_outreaches_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "callback_outreaches" ADD CONSTRAINT "callback_outreaches_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
