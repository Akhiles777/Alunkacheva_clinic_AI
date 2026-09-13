-- Журнал переписки со специалистом: что ушло врачу и что пришло от неё.
--
-- Только добавление таблицы. Ничего не удаляется, не переименовывается и не
-- меняет тип; существующие вопросы (specialist_queries) не трогаются.
CREATE TABLE "specialist_messages" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "specialistId" TEXT NOT NULL,
    "queryId" TEXT,
    "direction" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "quoted" TEXT,
    "externalId" TEXT,
    "sentAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "specialist_messages_pkey" PRIMARY KEY ("id")
);

-- Повторная подгрузка истории одно и то же сообщение второй раз не заводит.
CREATE UNIQUE INDEX "specialist_messages_companyId_externalId_key"
    ON "specialist_messages"("companyId", "externalId");
CREATE INDEX "specialist_messages_specialistId_sentAt_idx"
    ON "specialist_messages"("specialistId", "sentAt");
CREATE INDEX "specialist_messages_queryId_idx"
    ON "specialist_messages"("queryId");

ALTER TABLE "specialist_messages" ADD CONSTRAINT "specialist_messages_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "specialist_messages" ADD CONSTRAINT "specialist_messages_specialistId_fkey"
    FOREIGN KEY ("specialistId") REFERENCES "clinic_specialists"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "specialist_messages" ADD CONSTRAINT "specialist_messages_queryId_fkey"
    FOREIGN KEY ("queryId") REFERENCES "specialist_queries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
