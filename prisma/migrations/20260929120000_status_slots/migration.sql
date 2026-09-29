-- Окошки из статусов WhatsApp: статусы клиники и закреплённые агентом окошки.
--
-- Только добавление: две новые таблицы, существующие не меняются. Записи в
-- YCLIENTS агент по-прежнему не создаёт — окошко закрепляется словами, а
-- оформляет запись администратор (CLAUDE.md §6).

CREATE TABLE IF NOT EXISTS "clinic_statuses" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "postedAt" TIMESTAMPTZ(3) NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clinic_statuses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "slot_holds" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "patientId" TEXT,
    "staffId" TEXT NOT NULL,
    "serviceId" TEXT,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'CHOICE',
    "statusText" TEXT NOT NULL,
    "statusExternalId" TEXT,
    "heldAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "slot_holds_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "clinic_statuses_companyId_postedAt_idx" ON "clinic_statuses"("companyId", "postedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "clinic_statuses_companyId_externalId_key" ON "clinic_statuses"("companyId", "externalId");
CREATE INDEX IF NOT EXISTS "slot_holds_companyId_staffId_startAt_idx" ON "slot_holds"("companyId", "staffId", "startAt");
CREATE INDEX IF NOT EXISTS "slot_holds_conversationId_state_idx" ON "slot_holds"("conversationId", "state");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clinic_statuses_companyId_fkey') THEN
    ALTER TABLE "clinic_statuses" ADD CONSTRAINT "clinic_statuses_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slot_holds_companyId_fkey') THEN
    ALTER TABLE "slot_holds" ADD CONSTRAINT "slot_holds_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slot_holds_conversationId_fkey') THEN
    ALTER TABLE "slot_holds" ADD CONSTRAINT "slot_holds_conversationId_fkey"
      FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
