"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import { writeAudit } from "@/lib/server/audit";
import { hashPassword, INVITE_PENDING } from "@/lib/auth";
import type { StaffRole } from "@/generated/prisma/enums";

/**
 * Сотрудники клиники — ровно один список. Учётная запись (StaffUser) первична:
 * без логина и пароля человека в системе нет. Для роли «Врач» к учётке
 * автоматически привязывается специалист (Staff) — это то, на что ссылаются
 * визиты и расписание. Раньше это были два независимых списка, и врач,
 * заведённый как учётка, не появлялся в расписании: пользователь видел
 * «сотрудников, которых не добавлял», и наоборот.
 *
 * Удаление — мягкое (deletedAt, §4): на специалистов ссылаются визиты
 * (Appointment.staffId Restrict). Платформа не даёт остаться без активного
 * владельца.
 */
export interface AccountRow {
  id: string; // существующие — cuid; новые — "new-*"
  name: string;
  email: string;
  role: StaffRole;
  isActive: boolean;
  /** Привязанный специалист — заполняется платформой для роли DOCTOR. */
  staffId: string | null;
  /** Специальность врача (для карточки в расписании). */
  specialty: string;
  /** Кабинет врача по умолчанию. */
  defaultRoomId: string | null;
  /** Только для записи: пароль нового сотрудника или сброс пароля. Наружу не отдаётся. */
  password?: string;
  /** Есть ли у учётки заданный пароль (для UI). */
  hasPassword?: boolean;
}

export interface StaffPeople {
  accounts: AccountRow[];
  roomOptions: { id: string; label: string }[];
  /**
   * Специалисты, которым можно выдать учётку: свободные плюс уже привязанный к
   * этой строке. Без этого списка врач с историей визитов (он пришёл из
   * YCLIENTS или заведён раньше) при выдаче логина задваивался бы новой
   * карточкой, и расписание показывало бы двух одинаковых людей.
   */
  specialistOptions: { id: string; name: string; specialty: string | null; takenBy: string | null }[];
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** У врача есть карточка специалиста; у остальных ролей её быть не должно. */
function needsSpecialist(role: StaffRole): boolean {
  return role === "DOCTOR";
}

export async function getStaffPeople(): Promise<StaffPeople> {
  const session = await getSession();
  const [accounts, rooms, specialists] = await Promise.all([
    prisma.staffUser.findMany({
      where: { companyId: session.companyId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      include: { staff: { select: { id: true, specialty: true, defaultRoomId: true, deletedAt: true } } },
    }),
    prisma.room.findMany({
      where: { companyId: session.companyId },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true },
    }),
    prisma.staff.findMany({
      where: { companyId: session.companyId, deletedAt: null },
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        name: true,
        specialty: true,
        // deletedAt нужен: удалённая учётка не должна считаться владельцем
        // специалиста, иначе живого врача нельзя привязать к новому логину.
        user: { select: { id: true, name: true, deletedAt: true } },
      },
    }),
  ]);

  return {
    accounts: accounts.map((a) => {
      const staff = a.staff && a.staff.deletedAt === null ? a.staff : null;
      return {
        id: a.id,
        name: a.name,
        email: a.email,
        role: a.role,
        isActive: a.isActive,
        staffId: staff?.id ?? null,
        specialty: staff?.specialty ?? "",
        defaultRoomId: staff?.defaultRoomId ?? null,
        hasPassword: a.passwordHash !== INVITE_PENDING && a.passwordHash.length > 0,
      };
    }),
    roomOptions: rooms.map((r) => ({ id: r.id, label: r.name.replace(/ —.*/, "") })),
    specialistOptions: specialists.map((s) => ({
      id: s.id,
      name: s.name,
      specialty: s.specialty,
      takenBy: s.user && s.user.deletedAt === null ? s.user.name : null,
    })),
  };
}

export async function saveAccounts(rows: AccountRow[]): Promise<StaffPeople> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");

  // Валидация почты и уникальности в наборе.
  const seen = new Set<string>();
  for (const a of rows) {
    const email = a.email.trim().toLowerCase();
    if (!a.name.trim()) throw new Error(`Укажите имя сотрудника (${email || "новая учётка"})`);
    if (!EMAIL_RE.test(email)) throw new Error(`Проверьте почту: ${a.name || email}`);
    if (seen.has(email)) throw new Error(`Почта повторяется: ${email}`);
    seen.add(email);
  }
  // Почта уникальна в пределах клиники, включая уже удалённых сотрудников:
  // индекс не смотрит на deletedAt. Проверяем заранее, иначе вместо понятного
  // сообщения пользователь получал 500.
  const emails = rows.map((a) => a.email.trim().toLowerCase());
  const clashes = await prisma.staffUser.findMany({
    where: { companyId: session.companyId, email: { in: emails } },
    select: { id: true, email: true, deletedAt: true },
  });
  const submittedIds = new Set(rows.filter((r) => !r.id.startsWith("new-")).map((r) => r.id));
  for (const clash of clashes) {
    if (submittedIds.has(clash.id)) continue;
    throw new Error(
      clash.deletedAt
        ? `Почта ${clash.email} уже занята удалённым сотрудником — выберите другую`
        : `Почта ${clash.email} уже занята`,
    );
  }

  // Один специалист — одна учётка (StaffUser.staffId уникален). Ловим это до
  // транзакции, чтобы вместо ошибки базы показать понятную причину.
  const takenStaff = new Set<string>();
  for (const a of rows) {
    if (!a.staffId) continue;
    if (takenStaff.has(a.staffId)) {
      throw new Error("Один специалист привязан к двум учётным записям — оставьте одну");
    }
    takenStaff.add(a.staffId);
  }
  // Нельзя остаться без активного владельца.
  if (!rows.some((a) => a.role === "OWNER" && a.isActive)) {
    throw new Error("Должен остаться хотя бы один активный владелец");
  }
  // Новому сотруднику обязателен пароль (≥6).
  for (const a of rows) {
    if (a.id.startsWith("new-") && (!a.password || a.password.length < 6)) {
      throw new Error(`Задайте пароль (не короче 6 символов) для «${a.name || a.email}»`);
    }
    if (a.password && a.password.length > 0 && a.password.length < 6) {
      throw new Error(`Пароль не короче 6 символов: «${a.name || a.email}»`);
    }
  }

  const existing = await prisma.staffUser.findMany({
    where: { companyId: session.companyId, deletedAt: null },
    select: { id: true, staffId: true },
  });
  const kept = new Set(rows.filter((r) => !r.id.startsWith("new-")).map((r) => r.id));
  const toDelete = existing.filter((e) => !kept.has(e.id));

  await prisma.$transaction(async (tx) => {
    // Удаление учётки уводит вместе с ней и карточку специалиста — иначе врач
    // остаётся в расписании после того, как его убрали из сотрудников.
    for (const del of toDelete) {
      await tx.staffUser.update({
        where: { id: del.id },
        data: { deletedAt: new Date(), isActive: false, staffId: null },
      });
      if (del.staffId) {
        await tx.staff.update({
          where: { id: del.staffId },
          data: { deletedAt: new Date(), isActive: false, defaultRoomId: null },
        });
      }
    }

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const name = r.name.trim();
      const base = {
        name,
        email: r.email.trim().toLowerCase(),
        role: r.role,
        isActive: r.isActive,
      };
      const specialistData = {
        name,
        specialty: r.specialty.trim() || null,
        defaultRoomId: r.defaultRoomId || null,
        isActive: r.isActive,
        deletedAt: null,
        sortOrder: i + 1,
      };

      // Учётка.
      let userId = r.id;
      if (r.id.startsWith("new-")) {
        const created = await tx.staffUser.create({
          data: {
            companyId: session.companyId,
            passwordHash: hashPassword(r.password ?? ""),
            ...base,
          },
          select: { id: true },
        });
        userId = created.id;
      } else {
        // Пароль меняем только если задан новый (сброс).
        const pwd = r.password && r.password.length >= 6 ? { passwordHash: hashPassword(r.password) } : {};
        await tx.staffUser.update({ where: { id: r.id }, data: { ...base, ...pwd } });
      }

      // Специалист — производная от учётки, а не отдельный список.
      if (needsSpecialist(r.role)) {
        if (r.staffId) {
          // Специалиста мог удерживать уже удалённый сотрудник — отпускаем,
          // иначе привязка упадёт на уникальном индексе staffId.
          await tx.staffUser.updateMany({
            where: { staffId: r.staffId, deletedAt: { not: null } },
            data: { staffId: null },
          });
          // Имя специалиста, пришедшего из YCLIENTS, там и ведётся (§2) —
          // локально переименовывать его нельзя, иначе синк вернёт своё.
          const existing = await tx.staff.findUnique({
            where: { id: r.staffId },
            select: { yclientsStaffId: true },
          });
          const data = existing?.yclientsStaffId
            ? { ...specialistData, name: undefined }
            : specialistData;
          await tx.staff.update({ where: { id: r.staffId }, data });
          await tx.staffUser.update({ where: { id: userId }, data: { staffId: r.staffId } });
        } else {
          const staff = await tx.staff.create({
            data: { companyId: session.companyId, yclientsStaffId: null, ...specialistData },
            select: { id: true },
          });
          await tx.staffUser.update({ where: { id: userId }, data: { staffId: staff.id } });
        }
      } else if (r.staffId) {
        // Роль сменилась с врача — карточку специалиста убираем.
        await tx.staffUser.update({ where: { id: userId }, data: { staffId: null } });
        await tx.staff.update({
          where: { id: r.staffId },
          data: { deletedAt: new Date(), isActive: false, defaultRoomId: null },
        });
      }
    }
  });

  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "accounts",
    meta: { count: rows.length, deleted: toDelete.length },
  });

  return getStaffPeople();
}
