-- Прогноз неявки и его исход: обратная связь по функции.
-- Только новая таблица, существующих данных не касается.
-- CreateTable
CREATE TABLE "no_show_predictions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "factors" JSONB NOT NULL,
    "reasons" TEXT[],
    "predictedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualOutcome" TEXT,
    "outcomeAt" TIMESTAMPTZ(3),
    "wasContacted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "no_show_predictions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "no_show_predictions_companyId_predictedAt_idx" ON "no_show_predictions"("companyId", "predictedAt");

-- CreateIndex
CREATE UNIQUE INDEX "no_show_predictions_appointmentId_key" ON "no_show_predictions"("appointmentId");

-- AddForeignKey
ALTER TABLE "no_show_predictions" ADD CONSTRAINT "no_show_predictions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "no_show_predictions" ADD CONSTRAINT "no_show_predictions_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

