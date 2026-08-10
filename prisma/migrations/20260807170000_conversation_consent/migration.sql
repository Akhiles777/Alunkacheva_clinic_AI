-- Согласие на обработку ПДн запрашивается в мессенджере до того, как у
-- пациента появляется карточка (§7), поэтому факт хранится на диалоге и
-- переносится в patient_consents при привязке карточки.
ALTER TABLE "conversations" ADD COLUMN "consentAskedAt" TIMESTAMPTZ(3);
ALTER TABLE "conversations" ADD COLUMN "consentGrantedAt" TIMESTAMPTZ(3);
