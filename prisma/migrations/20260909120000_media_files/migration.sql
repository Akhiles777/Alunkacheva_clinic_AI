-- Файлы, которые клиника отправляет пациентам.
-- Только создание новой таблицы: существующих данных не касается.
-- CreateTable
CREATE TABLE "media_files" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "storageId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileName" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "durationSec" INTEGER,
    "uploadedById" TEXT,
    "messageId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "media_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_files_storageId_key" ON "media_files"("storageId");

-- CreateIndex
CREATE INDEX "media_files_companyId_createdAt_idx" ON "media_files"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "media_files_messageId_idx" ON "media_files"("messageId");

-- AddForeignKey
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

