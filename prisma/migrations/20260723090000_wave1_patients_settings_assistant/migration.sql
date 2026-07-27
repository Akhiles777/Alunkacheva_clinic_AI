-- CreateEnum
CREATE TYPE "PatientRelationKind" AS ENUM ('PARENT', 'GUARDIAN', 'SPOUSE', 'OTHER');

-- CreateEnum
CREATE TYPE "PatientNoteKind" AS ENUM ('NO_CONSENT', 'INCOMPLETE_PASSPORT', 'ATTENTION', 'CUSTOM');

-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "CourseOrigin" AS ENUM ('YCLIENTS', 'MANUAL');

-- CreateEnum
CREATE TYPE "MessageTemplateStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('UNKNOWN', 'OK', 'FAILED');

-- CreateEnum
CREATE TYPE "Permission" AS ENUM ('VIEW_OTHER_PATIENTS', 'VIEW_REVENUE', 'EDIT_SETTINGS', 'MESSAGE_PATIENTS', 'VIEW_AUDIT');

-- AlterEnum
ALTER TYPE "Channel" ADD VALUE 'PHONE';

-- DropIndex
DROP INDEX "patients_companyId_phone_idx";

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "bookedByPatientId" TEXT,
ADD COLUMN     "bookedByStaffUserId" TEXT,
ADD COLUMN     "primaryServiceId" TEXT;

-- AlterTable
ALTER TABLE "courses" ADD COLUMN     "origin" "CourseOrigin" NOT NULL DEFAULT 'YCLIENTS';

-- AlterTable
ALTER TABLE "inquiries" ADD COLUMN     "callLogId" TEXT,
ALTER COLUMN "conversationId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "rooms" ADD COLUMN     "direction" TEXT,
ADD COLUMN     "inheritsClinicSchedule" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "services" ADD COLUMN     "stalledAfterDays" INTEGER;

-- CreateTable
CREATE TABLE "daily_service_load_rollups" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "serviceId" TEXT NOT NULL,
    "busyMinutes" INTEGER NOT NULL DEFAULT 0,
    "availableMinutes" INTEGER NOT NULL DEFAULT 0,
    "appointments" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "daily_service_load_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_phones" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "label" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "usedForWhatsapp" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_phones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_relations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "relatedPatientId" TEXT NOT NULL,
    "kind" "PatientRelationKind" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_relations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_notes" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "kind" "PatientNoteKind" NOT NULL,
    "text" TEXT NOT NULL,
    "createdById" TEXT,
    "resolvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_logs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "patientId" TEXT,
    "phone" TEXT NOT NULL,
    "direction" "CallDirection" NOT NULL,
    "serviceInterestId" TEXT,
    "sourceId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "resultedInAppointmentId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "bodyTemplate" TEXT NOT NULL,
    "variables" JSONB,
    "providerTemplateId" TEXT,
    "status" "MessageTemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_entries" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "serviceId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "knowledge_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "companyId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("companyId","key")
);

-- CreateTable
CREATE TABLE "credentials" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "keyName" TEXT NOT NULL,
    "valueEncrypted" TEXT NOT NULL,
    "lastCheckedAt" TIMESTAMPTZ(3),
    "status" "CredentialStatus" NOT NULL DEFAULT 'UNKNOWN',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinic_schedules" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clinic_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinic_schedule_exceptions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT true,
    "startMinute" INTEGER,
    "endMinute" INTEGER,
    "label" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clinic_schedule_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_rooms" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_documents" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "policyUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_consents" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "grantedAt" TIMESTAMPTZ(3) NOT NULL,
    "channel" "Channel",
    "evidenceMessageId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL,
    "permission" "Permission" NOT NULL,
    "allowed" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "daily_service_load_rollups_companyId_date_idx" ON "daily_service_load_rollups"("companyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_service_load_rollups_companyId_date_serviceId_key" ON "daily_service_load_rollups"("companyId", "date", "serviceId");

-- CreateIndex
CREATE INDEX "patient_phones_companyId_phone_idx" ON "patient_phones"("companyId", "phone");

-- CreateIndex
CREATE INDEX "patient_phones_patientId_idx" ON "patient_phones"("patientId");

-- CreateIndex
CREATE INDEX "patient_relations_companyId_relatedPatientId_idx" ON "patient_relations"("companyId", "relatedPatientId");

-- CreateIndex
CREATE UNIQUE INDEX "patient_relations_patientId_relatedPatientId_kind_key" ON "patient_relations"("patientId", "relatedPatientId", "kind");

-- CreateIndex
CREATE INDEX "patient_notes_companyId_patientId_idx" ON "patient_notes"("companyId", "patientId");

-- CreateIndex
CREATE INDEX "patient_notes_companyId_resolvedAt_idx" ON "patient_notes"("companyId", "resolvedAt");

-- CreateIndex
CREATE INDEX "call_logs_companyId_createdAt_idx" ON "call_logs"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "call_logs_companyId_patientId_idx" ON "call_logs"("companyId", "patientId");

-- CreateIndex
CREATE INDEX "message_templates_companyId_channel_status_idx" ON "message_templates"("companyId", "channel", "status");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_companyId_code_key" ON "message_templates"("companyId", "code");

-- CreateIndex
CREATE INDEX "knowledge_entries_companyId_isActive_idx" ON "knowledge_entries"("companyId", "isActive");

-- CreateIndex
CREATE INDEX "knowledge_entries_companyId_serviceId_idx" ON "knowledge_entries"("companyId", "serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "credentials_companyId_provider_keyName_key" ON "credentials"("companyId", "provider", "keyName");

-- CreateIndex
CREATE INDEX "clinic_schedules_companyId_weekday_idx" ON "clinic_schedules"("companyId", "weekday");

-- CreateIndex
CREATE UNIQUE INDEX "clinic_schedules_companyId_weekday_validFrom_key" ON "clinic_schedules"("companyId", "weekday", "validFrom");

-- CreateIndex
CREATE INDEX "clinic_schedule_exceptions_companyId_date_idx" ON "clinic_schedule_exceptions"("companyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "clinic_schedule_exceptions_companyId_date_key" ON "clinic_schedule_exceptions"("companyId", "date");

-- CreateIndex
CREATE INDEX "service_rooms_companyId_roomId_idx" ON "service_rooms"("companyId", "roomId");

-- CreateIndex
CREATE UNIQUE INDEX "service_rooms_serviceId_roomId_key" ON "service_rooms"("serviceId", "roomId");

-- CreateIndex
CREATE UNIQUE INDEX "consent_documents_companyId_version_key" ON "consent_documents"("companyId", "version");

-- CreateIndex
CREATE INDEX "patient_consents_companyId_patientId_idx" ON "patient_consents"("companyId", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "patient_consents_patientId_documentId_key" ON "patient_consents"("patientId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_companyId_role_permission_key" ON "role_permissions"("companyId", "role", "permission");

-- CreateIndex
CREATE INDEX "appointments_companyId_primaryServiceId_startAt_idx" ON "appointments"("companyId", "primaryServiceId", "startAt");

-- CreateIndex
CREATE UNIQUE INDEX "inquiries_callLogId_key" ON "inquiries"("callLogId");

-- CreateIndex
CREATE INDEX "inquiries_companyId_channel_startedAt_idx" ON "inquiries"("companyId", "channel", "startedAt");

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_callLogId_fkey" FOREIGN KEY ("callLogId") REFERENCES "call_logs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_primaryServiceId_fkey" FOREIGN KEY ("primaryServiceId") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_bookedByPatientId_fkey" FOREIGN KEY ("bookedByPatientId") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_bookedByStaffUserId_fkey" FOREIGN KEY ("bookedByStaffUserId") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_service_load_rollups" ADD CONSTRAINT "daily_service_load_rollups_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_phones" ADD CONSTRAINT "patient_phones_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_phones" ADD CONSTRAINT "patient_phones_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_relations" ADD CONSTRAINT "patient_relations_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_relations" ADD CONSTRAINT "patient_relations_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_relations" ADD CONSTRAINT "patient_relations_relatedPatientId_fkey" FOREIGN KEY ("relatedPatientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_notes" ADD CONSTRAINT "patient_notes_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_notes" ADD CONSTRAINT "patient_notes_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_notes" ADD CONSTRAINT "patient_notes_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_serviceInterestId_fkey" FOREIGN KEY ("serviceInterestId") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_resultedInAppointmentId_fkey" FOREIGN KEY ("resultedInAppointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings" ADD CONSTRAINT "settings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings" ADD CONSTRAINT "settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinic_schedules" ADD CONSTRAINT "clinic_schedules_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinic_schedule_exceptions" ADD CONSTRAINT "clinic_schedule_exceptions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_rooms" ADD CONSTRAINT "service_rooms_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_rooms" ADD CONSTRAINT "service_rooms_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_rooms" ADD CONSTRAINT "service_rooms_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_documents" ADD CONSTRAINT "consent_documents_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_documents" ADD CONSTRAINT "consent_documents_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_consents" ADD CONSTRAINT "patient_consents_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_consents" ADD CONSTRAINT "patient_consents_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_consents" ADD CONSTRAINT "patient_consents_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "consent_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────── Волна 1: перенос данных перед удалением колонок patients ───────────
-- Телефон пациента → patient_phones как основной (isPrimary). Номера не теряются.
INSERT INTO "patient_phones" ("id","companyId","patientId","phone","isPrimary","usedForWhatsapp","createdAt")
SELECT gen_random_uuid()::text, "companyId", "id", "phone", true, false, now()
FROM "patients"
WHERE "phone" IS NOT NULL AND "phone" <> '';

-- Согласие на ПДн → версия текста (ConsentDocument) + факт согласия (PatientConsent).
INSERT INTO "consent_documents" ("id","companyId","version","text","isActive","createdAt")
SELECT gen_random_uuid()::text, "companyId", COALESCE("consentPolicyVersion", 'legacy'),
       'Импортировано из прежней версии схемы', false, now()
FROM "patients"
WHERE "consentGivenAt" IS NOT NULL
GROUP BY "companyId", COALESCE("consentPolicyVersion", 'legacy');

INSERT INTO "patient_consents" ("id","companyId","patientId","documentId","grantedAt","createdAt")
SELECT gen_random_uuid()::text, p."companyId", p."id", d."id", p."consentGivenAt", now()
FROM "patients" p
JOIN "consent_documents" d
  ON d."companyId" = p."companyId"
 AND d."version" = COALESCE(p."consentPolicyVersion", 'legacy')
WHERE p."consentGivenAt" IS NOT NULL;

-- Данные перенесены — колонки можно удалить.
ALTER TABLE "patients" DROP COLUMN "consentGivenAt",
DROP COLUMN "consentPolicyVersion",
DROP COLUMN "phone",
DROP COLUMN "phoneRaw";

-- Ровно один основной номер на пациента (частичный уникальный индекс).
CREATE UNIQUE INDEX "patient_phones_one_primary"
  ON "patient_phones" ("patientId") WHERE "isPrimary";
