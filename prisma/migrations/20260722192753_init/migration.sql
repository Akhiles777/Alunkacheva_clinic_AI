-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('INSTAGRAM', 'WHATSAPP', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('BOT_ACTIVE', 'ESCALATED', 'HUMAN_TAKEOVER', 'CLOSED');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "AuthorType" AS ENUM ('PATIENT', 'BOT', 'STAFF');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('DRAFT', 'QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "InquiryOutcome" AS ENUM ('PENDING', 'BOOKED', 'LOST');

-- CreateEnum
CREATE TYPE "EscalationReason" AS ENUM ('AGENT_REQUEST', 'PATIENT_REQUEST', 'KEYWORD', 'MEDICAL_QUESTION', 'MISUNDERSTOOD', 'TIMEOUT', 'OTHER');

-- CreateEnum
CREATE TYPE "EscalationUrgency" AS ENUM ('LOW', 'NORMAL', 'HIGH');

-- CreateEnum
CREATE TYPE "EscalationStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('CREATED', 'CONFIRMED', 'ARRIVED', 'NO_SHOW', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VisitKind" AS ENUM ('FIRST', 'COURSE_SESSION', 'RETURN');

-- CreateEnum
CREATE TYPE "ServiceKind" AS ENUM ('OSTEOPATHY', 'BIOFEEDBACK', 'IV_THERAPY', 'NEUROMEDITATION', 'LAB', 'OTHER');

-- CreateEnum
CREATE TYPE "CourseStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('MESSENGER', 'PHONE', 'WEB', 'OFFLINE', 'REFERRAL');

-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'DOCTOR');

-- CreateEnum
CREATE TYPE "WebhookProvider" AS ENUM ('YCLIENTS', 'INSTAGRAM', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "SyncEntity" AS ENUM ('CLIENTS', 'RECORDS', 'VISITS', 'STAFF', 'SERVICES', 'RESOURCES', 'TRANSACTIONS');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('IDLE', 'RUNNING', 'OK', 'FAILED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('LOGIN', 'LOGOUT', 'PATIENT_VIEW', 'PATIENT_EXPORT', 'CONVERSATION_VIEW', 'MESSAGE_SEND', 'APPOINTMENT_CREATE', 'APPOINTMENT_CANCEL', 'SETTINGS_UPDATE');

-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "yclientsId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Moscow',
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "dayStartMinute" INTEGER NOT NULL DEFAULT 540,
    "dayEndMinute" INTEGER NOT NULL DEFAULT 1260,
    "consentPolicyUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patients" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "yclientsId" INTEGER,
    "phone" TEXT NOT NULL,
    "phoneRaw" TEXT,
    "name" TEXT,
    "birthDate" DATE,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "firstVisitAt" TIMESTAMPTZ(3),
    "lastVisitAt" TIMESTAMPTZ(3),
    "sourceId" TEXT,
    "consentGivenAt" TIMESTAMPTZ(3),
    "consentPolicyVersion" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "patientId" TEXT,
    "channel" "Channel" NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "status" "ConversationStatus" NOT NULL DEFAULT 'BOT_ACTIVE',
    "assignedToId" TEXT,
    "sourceId" TEXT,
    "botPausedUntil" TIMESTAMPTZ(3),
    "replyWindowExpiresAt" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastMessageAt" TIMESTAMPTZ(3) NOT NULL,
    "lastPatientMessageAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "authorType" "AuthorType" NOT NULL,
    "authorId" TEXT,
    "body" TEXT NOT NULL,
    "attachments" JSONB,
    "externalId" TEXT,
    "status" "MessageStatus" NOT NULL DEFAULT 'SENT',
    "isDraft" BOOLEAN NOT NULL DEFAULT false,
    "approvedById" TEXT,
    "failureReason" TEXT,
    "sentAt" TIMESTAMPTZ(3),
    "deliveredAt" TIMESTAMPTZ(3),
    "readAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inquiries" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "patientId" TEXT,
    "sourceId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastMessageAt" TIMESTAMPTZ(3) NOT NULL,
    "messageCount" INTEGER NOT NULL DEFAULT 1,
    "outcome" "InquiryOutcome" NOT NULL DEFAULT 'PENDING',
    "firstMessageId" TEXT,
    "appointmentId" TEXT,
    "bookedAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inquiries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escalations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "inquiryId" TEXT,
    "reason" "EscalationReason" NOT NULL,
    "reasonText" TEXT,
    "urgency" "EscalationUrgency" NOT NULL DEFAULT 'NORMAL',
    "status" "EscalationStatus" NOT NULL DEFAULT 'OPEN',
    "notifiedAt" TIMESTAMPTZ(3),
    "acknowledgedById" TEXT,
    "acknowledgedAt" TIMESTAMPTZ(3),
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "escalations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "yclientsRecordId" INTEGER NOT NULL,
    "yclientsVisitId" INTEGER,
    "patientId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "roomId" TEXT,
    "courseId" TEXT,
    "sourceId" TEXT,
    "conversationId" TEXT,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "endAt" TIMESTAMPTZ(3) NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'CREATED',
    "attendanceRaw" INTEGER,
    "isFirstVisit" BOOLEAN NOT NULL DEFAULT false,
    "visitKind" "VisitKind",
    "revenue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "isPaid" BOOLEAN NOT NULL DEFAULT false,
    "courseSessionIndex" INTEGER,
    "createdAtYclients" TIMESTAMPTZ(3) NOT NULL,
    "updatedAtYclients" TIMESTAMPTZ(3) NOT NULL,
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_services" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "priceCharged" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "durationMin" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "yclientsServiceId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "ServiceKind" NOT NULL DEFAULT 'OTHER',
    "price" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "durationMin" INTEGER NOT NULL,
    "isCourse" BOOLEAN NOT NULL DEFAULT false,
    "defaultSessions" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courses" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "yclientsAbonementId" INTEGER,
    "sessionsTotal" INTEGER NOT NULL,
    "sessionsUsed" INTEGER NOT NULL DEFAULT 0,
    "amount" DECIMAL(12,2) NOT NULL,
    "pricePerSession" DECIMAL(12,2) NOT NULL,
    "status" "CourseStatus" NOT NULL DEFAULT 'ACTIVE',
    "purchasedAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "yclientsStaffId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "specialty" TEXT,
    "defaultRoomId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "yclientsResourceId" INTEGER,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_schedules" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_schedule_exceptions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT true,
    "startMinute" INTEGER,
    "endMinute" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_schedule_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_users" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL DEFAULT 'ADMIN',
    "staffId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "staff_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "staffUserId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sources" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "SourceKind" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "provider" "WebhookProvider" NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "actorId" TEXT,
    "action" "AuditAction" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_cursors" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "entity" "SyncEntity" NOT NULL,
    "lastSyncedAt" TIMESTAMPTZ(3),
    "lastCursor" TEXT,
    "status" "SyncStatus" NOT NULL DEFAULT 'IDLE',
    "error" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sync_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_funnel_rollups" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "sourceId" TEXT NOT NULL,
    "inquiries" INTEGER NOT NULL DEFAULT 0,
    "booked" INTEGER NOT NULL DEFAULT 0,
    "arrived" INTEGER NOT NULL DEFAULT 0,
    "newPatients" INTEGER NOT NULL DEFAULT 0,
    "escalations" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "daily_funnel_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_revenue_rollups" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "staffId" TEXT NOT NULL,
    "appointments" INTEGER NOT NULL DEFAULT 0,
    "arrived" INTEGER NOT NULL DEFAULT 0,
    "firstVisits" INTEGER NOT NULL DEFAULT 0,
    "courseVisits" INTEGER NOT NULL DEFAULT 0,
    "returnVisits" INTEGER NOT NULL DEFAULT 0,
    "revenue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "courseRevenue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "daily_revenue_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_room_load_rollups" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "roomId" TEXT NOT NULL,
    "busyMinutes" INTEGER NOT NULL DEFAULT 0,
    "workingMinutes" INTEGER NOT NULL DEFAULT 0,
    "appointments" INTEGER NOT NULL DEFAULT 0,
    "longestGapMin" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "daily_room_load_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "companies_yclientsId_key" ON "companies"("yclientsId");

-- CreateIndex
CREATE INDEX "patients_companyId_phone_idx" ON "patients"("companyId", "phone");

-- CreateIndex
CREATE INDEX "patients_companyId_firstSeenAt_idx" ON "patients"("companyId", "firstSeenAt");

-- CreateIndex
CREATE INDEX "patients_companyId_lastVisitAt_idx" ON "patients"("companyId", "lastVisitAt");

-- CreateIndex
CREATE INDEX "patients_companyId_deletedAt_idx" ON "patients"("companyId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "patients_companyId_yclientsId_key" ON "patients"("companyId", "yclientsId");

-- CreateIndex
CREATE INDEX "conversations_companyId_status_lastMessageAt_idx" ON "conversations"("companyId", "status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "conversations_companyId_assignedToId_status_idx" ON "conversations"("companyId", "assignedToId", "status");

-- CreateIndex
CREATE INDEX "conversations_companyId_patientId_idx" ON "conversations"("companyId", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_companyId_channel_externalUserId_key" ON "conversations"("companyId", "channel", "externalUserId");

-- CreateIndex
CREATE INDEX "messages_conversationId_createdAt_idx" ON "messages"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "messages_companyId_createdAt_idx" ON "messages"("companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "messages_channel_externalId_key" ON "messages"("channel", "externalId");

-- CreateIndex
CREATE INDEX "inquiries_companyId_startedAt_idx" ON "inquiries"("companyId", "startedAt");

-- CreateIndex
CREATE INDEX "inquiries_companyId_sourceId_startedAt_idx" ON "inquiries"("companyId", "sourceId", "startedAt");

-- CreateIndex
CREATE INDEX "inquiries_companyId_outcome_idx" ON "inquiries"("companyId", "outcome");

-- CreateIndex
CREATE UNIQUE INDEX "inquiries_conversationId_startedAt_key" ON "inquiries"("conversationId", "startedAt");

-- CreateIndex
CREATE INDEX "escalations_companyId_status_createdAt_idx" ON "escalations"("companyId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "escalations_conversationId_createdAt_idx" ON "escalations"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "appointments_companyId_startAt_idx" ON "appointments"("companyId", "startAt");

-- CreateIndex
CREATE INDEX "appointments_companyId_staffId_startAt_idx" ON "appointments"("companyId", "staffId", "startAt");

-- CreateIndex
CREATE INDEX "appointments_companyId_roomId_startAt_idx" ON "appointments"("companyId", "roomId", "startAt");

-- CreateIndex
CREATE INDEX "appointments_companyId_patientId_startAt_idx" ON "appointments"("companyId", "patientId", "startAt");

-- CreateIndex
CREATE INDEX "appointments_companyId_status_createdAtYclients_idx" ON "appointments"("companyId", "status", "createdAtYclients");

-- CreateIndex
CREATE INDEX "appointments_companyId_courseId_idx" ON "appointments"("companyId", "courseId");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_companyId_yclientsRecordId_key" ON "appointments"("companyId", "yclientsRecordId");

-- CreateIndex
CREATE INDEX "appointment_services_companyId_serviceId_idx" ON "appointment_services"("companyId", "serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_services_appointmentId_serviceId_key" ON "appointment_services"("appointmentId", "serviceId");

-- CreateIndex
CREATE INDEX "services_companyId_kind_isActive_idx" ON "services"("companyId", "kind", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "services_companyId_yclientsServiceId_key" ON "services"("companyId", "yclientsServiceId");

-- CreateIndex
CREATE INDEX "courses_companyId_patientId_status_idx" ON "courses"("companyId", "patientId", "status");

-- CreateIndex
CREATE INDEX "courses_companyId_purchasedAt_idx" ON "courses"("companyId", "purchasedAt");

-- CreateIndex
CREATE UNIQUE INDEX "courses_companyId_yclientsAbonementId_key" ON "courses"("companyId", "yclientsAbonementId");

-- CreateIndex
CREATE INDEX "staff_companyId_isActive_idx" ON "staff"("companyId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "staff_companyId_yclientsStaffId_key" ON "staff"("companyId", "yclientsStaffId");

-- CreateIndex
CREATE INDEX "rooms_companyId_isActive_idx" ON "rooms"("companyId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_companyId_yclientsResourceId_key" ON "rooms"("companyId", "yclientsResourceId");

-- CreateIndex
CREATE INDEX "room_schedules_companyId_roomId_weekday_idx" ON "room_schedules"("companyId", "roomId", "weekday");

-- CreateIndex
CREATE UNIQUE INDEX "room_schedules_roomId_weekday_validFrom_key" ON "room_schedules"("roomId", "weekday", "validFrom");

-- CreateIndex
CREATE INDEX "room_schedule_exceptions_companyId_date_idx" ON "room_schedule_exceptions"("companyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "room_schedule_exceptions_roomId_date_key" ON "room_schedule_exceptions"("roomId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "staff_users_staffId_key" ON "staff_users"("staffId");

-- CreateIndex
CREATE INDEX "staff_users_companyId_role_isActive_idx" ON "staff_users"("companyId", "role", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "staff_users_companyId_email_key" ON "staff_users"("companyId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_companyId_staffUserId_idx" ON "push_subscriptions"("companyId", "staffUserId");

-- CreateIndex
CREATE UNIQUE INDEX "sources_companyId_code_key" ON "sources"("companyId", "code");

-- CreateIndex
CREATE INDEX "webhook_events_status_receivedAt_idx" ON "webhook_events"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "webhook_events_companyId_provider_receivedAt_idx" ON "webhook_events"("companyId", "provider", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_externalEventId_key" ON "webhook_events"("provider", "externalEventId");

-- CreateIndex
CREATE INDEX "audit_logs_companyId_createdAt_idx" ON "audit_logs"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_companyId_actorId_createdAt_idx" ON "audit_logs"("companyId", "actorId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_companyId_entityType_entityId_idx" ON "audit_logs"("companyId", "entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "sync_cursors_companyId_entity_key" ON "sync_cursors"("companyId", "entity");

-- CreateIndex
CREATE INDEX "daily_funnel_rollups_companyId_date_idx" ON "daily_funnel_rollups"("companyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_funnel_rollups_companyId_date_sourceId_key" ON "daily_funnel_rollups"("companyId", "date", "sourceId");

-- CreateIndex
CREATE INDEX "daily_revenue_rollups_companyId_date_idx" ON "daily_revenue_rollups"("companyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_revenue_rollups_companyId_date_staffId_key" ON "daily_revenue_rollups"("companyId", "date", "staffId");

-- CreateIndex
CREATE INDEX "daily_room_load_rollups_companyId_date_idx" ON "daily_room_load_rollups"("companyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_room_load_rollups_companyId_date_roomId_key" ON "daily_room_load_rollups"("companyId", "date", "roomId");

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_firstMessageId_fkey" FOREIGN KEY ("firstMessageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "inquiries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_services" ADD CONSTRAINT "appointment_services_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_services" ADD CONSTRAINT "appointment_services_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_services" ADD CONSTRAINT "appointment_services_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_defaultRoomId_fkey" FOREIGN KEY ("defaultRoomId") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_schedules" ADD CONSTRAINT "room_schedules_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_schedules" ADD CONSTRAINT "room_schedules_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_schedule_exceptions" ADD CONSTRAINT "room_schedule_exceptions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_schedule_exceptions" ADD CONSTRAINT "room_schedule_exceptions_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "staff_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sources" ADD CONSTRAINT "sources_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_funnel_rollups" ADD CONSTRAINT "daily_funnel_rollups_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_funnel_rollups" ADD CONSTRAINT "daily_funnel_rollups_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_revenue_rollups" ADD CONSTRAINT "daily_revenue_rollups_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_room_load_rollups" ADD CONSTRAINT "daily_room_load_rollups_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
