-- Телефон собеседника: адрес чата в WhatsApp его больше не содержит (@lid).
ALTER TABLE "conversations" ADD COLUMN "phoneE164" TEXT;
CREATE INDEX "conversations_companyId_phoneE164_idx" ON "conversations"("companyId", "phoneE164");
