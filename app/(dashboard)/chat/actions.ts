"use server";

import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { getSession, type Session } from "@/lib/server/session";
import { Prisma } from "@/generated/prisma/client";

export type InternalRoomKind = "GENERAL" | "DIRECT";
export type InternalMessageKind = "TEXT" | "VOICE" | "SYSTEM";

export interface InternalStaff {
  id: string;
  name: string;
  role: string;
  email: string;
  staffId: string | null;
  specialty: string | null;
  roomName: string | null;
  isSelf: boolean;
}

export interface InternalChatRoomView {
  id: string;
  kind: InternalRoomKind;
  title: string;
  peerId: string | null;
  lastMessageAt: string | null;
  unread: number;
}

export interface InternalChatAttachment {
  kind: "patient" | "course" | "voice";
  label?: string;
  detail?: string;
  patientId?: string;
  mimeType?: string;
  dataUrl?: string;
  durationSec?: number;
}

export interface InternalChatMessageView {
  id: string;
  roomId: string;
  authorId: string;
  authorName: string;
  kind: InternalMessageKind;
  body: string;
  attachments: InternalChatAttachment[];
  createdAt: string;
  mine: boolean;
  deleted: boolean;
  canDelete: boolean;
}

export interface InternalChatState {
  me: InternalStaff;
  staff: InternalStaff[];
  rooms: InternalChatRoomView[];
  activeRoomId: string;
  messages: InternalChatMessageView[];
}

type StaffRow = {
  id: string;
  name: string;
  role: string;
  email: string;
  staffId: string | null;
  specialty: string | null;
  roomName: string | null;
};
type RoomRow = {
  id: string;
  kind: InternalRoomKind;
  title: string | null;
  updatedAt: Date;
  lastMessageAt: Date | null;
  peerId: string | null;
  peerName: string | null;
  unread: bigint | number;
};
type MessageRow = {
  id: string;
  roomId: string;
  authorId: string;
  authorName: string;
  kind: InternalMessageKind;
  body: string;
  attachments: unknown;
  createdAt: Date;
  deletedAt: Date | null;
};

function requireUser(session: Session): string {
  if (!session.userId) {
    throw new Error("Требуется вход реального пользователя.");
  }
  return session.userId;
}

function cuid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function normalizeAttachments(value: unknown): InternalChatAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    if (raw.kind !== "patient" && raw.kind !== "course" && raw.kind !== "voice") return [];
    return [{
      kind: raw.kind,
      label: typeof raw.label === "string" ? raw.label.slice(0, 160) : undefined,
      detail: typeof raw.detail === "string" ? raw.detail.slice(0, 500) : undefined,
      patientId: typeof raw.patientId === "string" ? raw.patientId : undefined,
      mimeType: typeof raw.mimeType === "string" ? raw.mimeType.slice(0, 80) : undefined,
      dataUrl: typeof raw.dataUrl === "string" ? raw.dataUrl : undefined,
      durationSec: typeof raw.durationSec === "number" && Number.isFinite(raw.durationSec)
        ? Math.max(0, Math.min(600, Math.round(raw.durationSec)))
        : undefined,
    }];
  });
}

function validateOutgoingAttachments(value: InternalChatAttachment[] | undefined): InternalChatAttachment[] {
  const attachments = normalizeAttachments(value ?? []);
  const voice = attachments.find((a) => a.kind === "voice");
  if (voice?.dataUrl) {
    if (!voice.dataUrl.startsWith("data:audio/")) throw new Error("Некорректный формат голосового сообщения.");
    if (voice.dataUrl.length > 760_000) throw new Error("Голосовое сообщение слишком длинное.");
  }
  return attachments;
}

async function assertActiveUser(session: Session, userId: string): Promise<void> {
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id
    FROM staff_users
    WHERE id = ${userId}
      AND "companyId" = ${session.companyId}
      AND "isActive" = true
      AND "deletedAt" IS NULL
    LIMIT 1
  `);
  if (!rows[0]) throw new Error("Пользователь не найден или отключён.");
}

async function ensureDoctorAccounts(session: Session): Promise<void> {
  const doctors = await prisma.$queryRaw<{ id: string; name: string }[]>(Prisma.sql`
    SELECT s.id, s.name
    FROM staff s
    LEFT JOIN staff_users u ON u."staffId" = s.id AND u."deletedAt" IS NULL
    WHERE s."companyId" = ${session.companyId}
      AND s."isActive" = true
      AND s."deletedAt" IS NULL
      AND u.id IS NULL
  `);
  for (const doctor of doctors) {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO staff_users (id, "companyId", email, "passwordHash", name, role, "staffId", "isActive", "updatedAt")
      VALUES (
        ${cuid("user")},
        ${session.companyId},
        ${`doctor-${doctor.id}@mera.local`},
        '!invite-pending',
        ${doctor.name},
        'DOCTOR'::"StaffRole",
        ${doctor.id},
        true,
        now()
      )
      ON CONFLICT ("companyId", email) DO NOTHING
    `);
  }
}

async function ensureGeneralRoom(session: Session, userId: string): Promise<string> {
  const existing = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id
    FROM internal_chat_rooms
    WHERE "companyId" = ${session.companyId}
      AND kind = 'GENERAL'::"InternalChatKind"
      AND "directKey" = 'general'
      AND "deletedAt" IS NULL
    LIMIT 1
  `);
  const roomId = existing[0]?.id ?? cuid("chat");
  if (!existing[0]) {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO internal_chat_rooms (id, "companyId", kind, title, "directKey", "updatedAt")
      VALUES (${roomId}, ${session.companyId}, 'GENERAL'::"InternalChatKind", 'Общий чат', 'general', now())
    `);
  }
  await ensureParticipant(session.companyId, roomId, userId);
  return roomId;
}

async function ensureParticipant(companyId: string, roomId: string, staffUserId: string): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO internal_chat_participants (id, "companyId", "roomId", "staffUserId")
    VALUES (${cuid("part")}, ${companyId}, ${roomId}, ${staffUserId})
    ON CONFLICT ("roomId", "staffUserId")
    DO UPDATE SET "deletedAt" = NULL
  `);
}

async function ensureDirectRoom(session: Session, userId: string, peerId: string): Promise<string> {
  if (userId === peerId) throw new Error("Нельзя открыть личный чат с самим собой.");
  await assertActiveUser(session, peerId);
  const directKey = [userId, peerId].sort().join(":");
  const existing = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id
    FROM internal_chat_rooms
    WHERE "companyId" = ${session.companyId}
      AND kind = 'DIRECT'::"InternalChatKind"
      AND "directKey" = ${directKey}
      AND "deletedAt" IS NULL
    LIMIT 1
  `);
  const roomId = existing[0]?.id ?? cuid("chat");
  if (!existing[0]) {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO internal_chat_rooms (id, "companyId", kind, "directKey", "updatedAt")
      VALUES (${roomId}, ${session.companyId}, 'DIRECT'::"InternalChatKind", ${directKey}, now())
    `);
  }
  await ensureParticipant(session.companyId, roomId, userId);
  await ensureParticipant(session.companyId, roomId, peerId);
  return roomId;
}

async function assertRoomMember(session: Session, userId: string, roomId: string): Promise<void> {
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT p.id
    FROM internal_chat_participants p
    JOIN internal_chat_rooms r ON r.id = p."roomId"
    WHERE p."roomId" = ${roomId}
      AND p."staffUserId" = ${userId}
      AND p."companyId" = ${session.companyId}
      AND p."deletedAt" IS NULL
      AND r."deletedAt" IS NULL
    LIMIT 1
  `);
  if (!rows[0]) throw new Error("Нет доступа к этому чату.");
}

async function getStaff(session: Session, userId: string): Promise<InternalStaff[]> {
  const rows = await prisma.$queryRaw<StaffRow[]>(Prisma.sql`
    SELECT
      u.id,
      u.name,
      u.role::text AS role,
      u.email,
      u."staffId",
      s.specialty,
      r.name AS "roomName"
    FROM staff_users u
    LEFT JOIN staff s ON s.id = u."staffId" AND s."deletedAt" IS NULL
    LEFT JOIN rooms r ON r.id = s."defaultRoomId"
    WHERE u."companyId" = ${session.companyId}
      AND u."isActive" = true
      AND u."deletedAt" IS NULL
    ORDER BY
      CASE WHEN u.role = 'DOCTOR'::"StaffRole" OR u."staffId" IS NOT NULL THEN 0 ELSE 1 END,
      s."sortOrder" ASC NULLS LAST,
      u.name ASC
  `);
  return rows.map((s) => ({ ...s, isSelf: s.id === userId }));
}

async function getRooms(session: Session, userId: string): Promise<InternalChatRoomView[]> {
  const rows = await prisma.$queryRaw<RoomRow[]>(Prisma.sql`
    WITH visible_rooms AS (
      SELECT r.*
      FROM internal_chat_rooms r
      WHERE r."companyId" = ${session.companyId}
        AND r."deletedAt" IS NULL
        AND (
          r.kind = 'GENERAL'::"InternalChatKind"
          OR EXISTS (
            SELECT 1 FROM internal_chat_participants p
            WHERE p."roomId" = r.id
              AND p."staffUserId" = ${userId}
              AND p."deletedAt" IS NULL
          )
        )
    ),
    last_messages AS (
      SELECT "roomId", max("createdAt") AS "lastMessageAt"
      FROM internal_chat_messages
      WHERE "deletedAt" IS NULL
      GROUP BY "roomId"
    )
    SELECT
      r.id,
      r.kind::text AS kind,
      r.title,
      r."updatedAt",
      lm."lastMessageAt",
      peer.id AS "peerId",
      peer.name AS "peerName",
      (
        SELECT count(*)
        FROM internal_chat_messages m
        JOIN internal_chat_participants selfp ON selfp."roomId" = r.id AND selfp."staffUserId" = ${userId}
        WHERE m."roomId" = r.id
          AND m."authorId" <> ${userId}
          AND m."deletedAt" IS NULL
          AND (selfp."lastReadAt" IS NULL OR m."createdAt" > selfp."lastReadAt")
      ) AS unread
    FROM visible_rooms r
    LEFT JOIN last_messages lm ON lm."roomId" = r.id
    LEFT JOIN internal_chat_participants pp ON r.kind = 'DIRECT'::"InternalChatKind" AND pp."roomId" = r.id AND pp."staffUserId" <> ${userId} AND pp."deletedAt" IS NULL
    LEFT JOIN staff_users peer ON peer.id = pp."staffUserId"
    ORDER BY COALESCE(lm."lastMessageAt", r."updatedAt") DESC, r.kind ASC
  `);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.kind === "GENERAL" ? (r.title ?? "Общий чат") : (r.peerName ?? "Личный чат"),
    peerId: r.peerId,
    lastMessageAt: iso(r.lastMessageAt),
    unread: Number(r.unread),
  }));
}

async function getMessages(session: Session, userId: string, roomId: string): Promise<InternalChatMessageView[]> {
  await assertRoomMember(session, userId, roomId);
  const rows = await prisma.$queryRaw<MessageRow[]>(Prisma.sql`
    SELECT
      m.id,
      m."roomId",
      m."authorId",
      u.name AS "authorName",
      m.kind::text AS kind,
      m.body,
      m.attachments,
      m."createdAt",
      m."deletedAt"
    FROM internal_chat_messages m
    JOIN staff_users u ON u.id = m."authorId"
    WHERE m."companyId" = ${session.companyId}
      AND m."roomId" = ${roomId}
    ORDER BY m."createdAt" ASC
    LIMIT 200
  `);
  return rows.map((m) => {
    const deleted = m.deletedAt !== null;
    return {
      id: m.id,
      roomId: m.roomId,
      authorId: m.authorId,
      authorName: m.authorName,
      kind: m.kind,
      body: deleted ? "" : m.body,
      attachments: deleted ? [] : normalizeAttachments(m.attachments),
      createdAt: m.createdAt.toISOString(),
      mine: m.authorId === userId,
      deleted,
      canDelete: !deleted && (m.authorId === userId || session.role === "OWNER"),
    };
  });
}

export async function getInternalChatState(roomId?: string | null): Promise<InternalChatState> {
  const session = await getSession();
  const userId = requireUser(session);
  await assertActiveUser(session, userId);
  await ensureDoctorAccounts(session);
  const generalRoomId = await ensureGeneralRoom(session, userId);
  const activeRoomId = roomId ?? generalRoomId;
  await assertRoomMember(session, userId, activeRoomId);
  await markInternalChatRead(activeRoomId);

  const [staff, rooms, messages] = await Promise.all([
    getStaff(session, userId),
    getRooms(session, userId),
    getMessages(session, userId, activeRoomId),
  ]);
  const me = staff.find((s) => s.id === userId);
  if (!me) throw new Error("Пользователь не найден.");
  return { me, staff, rooms, activeRoomId, messages };
}

export async function openDirectChat(peerId: string): Promise<InternalChatState> {
  const session = await getSession();
  const userId = requireUser(session);
  await assertActiveUser(session, userId);
  const roomId = await ensureDirectRoom(session, userId, peerId);
  return getInternalChatState(roomId);
}

export async function sendInternalMessage(input: {
  roomId: string;
  body?: string;
  attachments?: InternalChatAttachment[];
}): Promise<InternalChatState> {
  const session = await getSession();
  const userId = requireUser(session);
  await assertActiveUser(session, userId);
  await assertRoomMember(session, userId, input.roomId);

  const body = (input.body ?? "").trim().slice(0, 4000);
  const attachments = validateOutgoingAttachments(input.attachments);
  if (!body && attachments.length === 0) return getInternalChatState(input.roomId);

  const kind: InternalMessageKind = attachments.some((a) => a.kind === "voice") ? "VOICE" : "TEXT";
  const json = attachments.length ? JSON.stringify(attachments) : null;
  if (json) {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO internal_chat_messages (id, "companyId", "roomId", "authorId", kind, body, attachments)
      VALUES (
        ${cuid("msg")},
        ${session.companyId},
        ${input.roomId},
        ${userId},
        ${kind}::"InternalChatMessageKind",
        ${body},
        CAST(${json} AS jsonb)
      )
    `);
  } else {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO internal_chat_messages (id, "companyId", "roomId", "authorId", kind, body)
      VALUES (
        ${cuid("msg")},
        ${session.companyId},
        ${input.roomId},
        ${userId},
        ${kind}::"InternalChatMessageKind",
        ${body}
      )
    `);
  }
  await prisma.$executeRaw(Prisma.sql`
    UPDATE internal_chat_rooms SET "updatedAt" = now() WHERE id = ${input.roomId} AND "companyId" = ${session.companyId}
  `);
  await markInternalChatRead(input.roomId);
  return getInternalChatState(input.roomId);
}

export async function deleteInternalMessage(messageId: string): Promise<InternalChatState> {
  const session = await getSession();
  const userId = requireUser(session);
  const rows = await prisma.$queryRaw<{ roomId: string; authorId: string }[]>(Prisma.sql`
    SELECT "roomId", "authorId"
    FROM internal_chat_messages
    WHERE id = ${messageId}
      AND "companyId" = ${session.companyId}
      AND "deletedAt" IS NULL
    LIMIT 1
  `);
  const msg = rows[0];
  if (!msg) throw new Error("Сообщение не найдено.");
  await assertRoomMember(session, userId, msg.roomId);
  if (msg.authorId !== userId && session.role !== "OWNER") throw new Error("Можно удалить только своё сообщение.");
  await prisma.$executeRaw(Prisma.sql`
    UPDATE internal_chat_messages
    SET "deletedAt" = now(), "deletedById" = ${userId}
    WHERE id = ${messageId}
      AND "companyId" = ${session.companyId}
  `);
  await prisma.$executeRaw(Prisma.sql`
    UPDATE internal_chat_rooms SET "updatedAt" = now() WHERE id = ${msg.roomId} AND "companyId" = ${session.companyId}
  `);
  return getInternalChatState(msg.roomId);
}

export async function markInternalChatRead(roomId: string): Promise<void> {
  const session = await getSession();
  const userId = requireUser(session);
  await prisma.$executeRaw(Prisma.sql`
    UPDATE internal_chat_participants
    SET "lastReadAt" = now()
    WHERE "companyId" = ${session.companyId}
      AND "roomId" = ${roomId}
      AND "staffUserId" = ${userId}
      AND "deletedAt" IS NULL
  `);
}
