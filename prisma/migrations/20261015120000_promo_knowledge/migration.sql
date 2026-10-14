-- Запись справочника может принадлежать акции: агент видит её только пока
-- акция идёт и пациент сам о ней спросил. Только добавление: колонка, индекс,
-- внешний ключ (удалить акцию с записями нельзя — иначе
-- они стали бы общими и ушли пациентам); существующие записи остаются общими (promoId = NULL).

-- AlterTable
ALTER TABLE "knowledge_entries" ADD COLUMN     "promoId" TEXT;

-- CreateIndex
CREATE INDEX "knowledge_entries_promoId_idx" ON "knowledge_entries"("promoId");

-- AddForeignKey
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_promoId_fkey" FOREIGN KEY ("promoId") REFERENCES "promos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

