-- Переносы записей.
--
-- Только добавление таблицы: ничего не удаляется, не переименовывается и не
-- меняет тип. Метрика начинает копиться со дня выкатки — прошлые переносы
-- восстановить неоткуда, YCLIENTS о них не сообщает.
CREATE TABLE "appointment_moves" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "patientId" TEXT,
    "fromStartAt" TIMESTAMPTZ(3) NOT NULL,
    "toStartAt" TIMESTAMPTZ(3) NOT NULL,
    "exact" BOOLEAN NOT NULL DEFAULT true,
    "detectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_moves_pkey" PRIMARY KEY ("id")
);

-- Повторная выгрузка тот же перенос второй раз не записывает.
CREATE UNIQUE INDEX "appointment_moves_companyId_appointmentId_fromStartAt_toStar_key"
    ON "appointment_moves"("companyId", "appointmentId", "fromStartAt", "toStartAt");
CREATE INDEX "appointment_moves_companyId_detectedAt_idx"
    ON "appointment_moves"("companyId", "detectedAt");

ALTER TABLE "appointment_moves" ADD CONSTRAINT "appointment_moves_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_moves" ADD CONSTRAINT "appointment_moves_appointmentId_fkey"
    FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
