"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import { writeAudit } from "@/lib/server/audit";
import { hashPassword, INVITE_PENDING, LOGIN_RE, normalizeLogin } from "@/lib/auth";
import type { StaffRole } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";

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
  /**
   * cuid учётной записи; "new-*" — новая строка; "staff-<id>" — специалист,
   * у которого учётной записи ещё нет. Последние показываем в том же списке:
   * иначе в отчётах шесть человек, а в настройках пусто — именно на это
   * жаловался заказчик.
   */
  id: string;
  name: string;
  login: string;
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
  /** Есть ли вход в систему. false — специалист заведён, но логина у него нет. */
  hasLogin: boolean;
  /** Сколько визитов на этом специалисте — видно, что человек реально работает. */
  visits?: number;
}

export interface StaffPeople {
  /** Что произошло при последнем сохранении — показываем рядом с «Сохранено». */
  notice?: string;
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

/**
 * Отменить будущие записи уволенного специалиста.
 *
 * Прошедшие визиты не трогаем — это история клиники и её выручка. А вот
 * будущие состояться уже не могут: оставлять их значит показывать в
 * расписании приёмы у человека, которого в клинике нет.
 */
async function cancelUpcoming(
  tx: Prisma.TransactionClient,
  companyId: string,
  staffId: string,
): Promise<number> {
  const res = await tx.appointment.updateMany({
    where: {
      companyId,
      staffId,
      deletedAt: null,
      status: { in: ["CREATED", "CONFIRMED"] },
      startAt: { gte: new Date() },
    },
    data: { status: "CANCELLED" },
  });
  return res.count;
}

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
        defaultRoomId: true,
        isActive: true,
        _count: { select: { appointments: true } },
        // deletedAt нужен: удалённая учётка не должна считаться владельцем
        // специалиста, иначе живого врача нельзя привязать к новому логину.
        user: { select: { id: true, name: true, deletedAt: true } },
      },
    }),
  ]);

  const accountRows: AccountRow[] = accounts.map((a) => {
    const staff = a.staff && a.staff.deletedAt === null ? a.staff : null;
    return {
      id: a.id,
      name: a.name,
      login: a.login,
      role: a.role,
      isActive: a.isActive,
      staffId: staff?.id ?? null,
      specialty: staff?.specialty ?? "",
      defaultRoomId: staff?.defaultRoomId ?? null,
      hasPassword: a.passwordHash !== INVITE_PENDING && a.passwordHash.length > 0,
      hasLogin: true,
    };
  });

  // Специалисты без входа в систему: они есть в расписании и в отчётах, значит
  // должны быть видны и здесь — с честной пометкой «нет доступа».
  const linked = new Set(accountRows.map((a) => a.staffId).filter(Boolean));
  const specialistRows: AccountRow[] = specialists
    .filter((s) => !linked.has(s.id) && !(s.user && s.user.deletedAt === null))
    .map((s) => ({
      id: `staff-${s.id}`,
      name: s.name,
      login: "",
      role: "DOCTOR" as StaffRole,
      isActive: s.isActive,
      staffId: s.id,
      specialty: s.specialty ?? "",
      defaultRoomId: s.defaultRoomId,
      hasPassword: false,
      hasLogin: false,
      visits: s._count.appointments,
    }));

  return {
    accounts: [...accountRows, ...specialistRows],
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

  /**
   * Строка специалиста без почты — это человек в расписании без входа в
   * систему. Он допустим: медсестра может работать, не заходя в платформу.
   * Как только почта заполнена, строка превращается в учётную запись.
   */
  const wantsLogin = (a: AccountRow) => a.hasLogin || a.login.trim().length > 0;

  // Валидация почты и уникальности среди тех, у кого есть вход.
  const seen = new Set<string>();
  for (const a of rows) {
    if (!a.name.trim()) throw new Error("У сотрудника должно быть имя");
    if (!wantsLogin(a)) continue;
    const login = normalizeLogin(a.login);
    if (!LOGIN_RE.test(login)) {
      throw new Error(`Логин «${login || a.name}»: латиница, цифры, точка, дефис — от 3 до 30 знаков`);
    }
    if (seen.has(login)) throw new Error(`Логин повторяется: ${login}`);
    seen.add(login);
  }
  // Почта уникальна в пределах клиники, включая уже удалённых сотрудников:
  // индекс не смотрит на deletedAt. Проверяем заранее, иначе вместо понятного
  // сообщения пользователь получал 500.
  const logins = rows.filter(wantsLogin).map((a) => normalizeLogin(a.login));
  const clashes = await prisma.staffUser.findMany({
    where: { companyId: session.companyId, login: { in: logins } },
    select: { id: true, login: true, deletedAt: true },
  });
  const submittedIds = new Set(
    rows.filter((r) => !r.id.startsWith("new-") && !r.id.startsWith("staff-")).map((r) => r.id),
  );
  for (const clash of clashes) {
    if (submittedIds.has(clash.id)) continue;
    throw new Error(
      clash.deletedAt
        ? `Логин ${clash.login} занят удалённым сотрудником — выберите другой`
        : `Логин ${clash.login} уже занят`,
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
  // Новому сотруднику обязателен пароль (≥6). Специалист, которому только что
  // выдают вход, тоже считается новым.
  const isNewLogin = (a: AccountRow) => a.id.startsWith("new-") || (a.id.startsWith("staff-") && wantsLogin(a));
  for (const a of rows) {
    if (isNewLogin(a) && (!a.password || a.password.length < 6)) {
      throw new Error(`Задайте пароль (не короче 6 символов) для «${a.name || a.login}»`);
    }
    if (a.password && a.password.length > 0 && a.password.length < 6) {
      throw new Error(`Пароль не короче 6 символов: «${a.name || a.login}»`);
    }
  }

  const existing = await prisma.staffUser.findMany({
    where: { companyId: session.companyId, deletedAt: null },
    select: { id: true, staffId: true },
  });
  const kept = new Set(
    rows.filter((r) => !r.id.startsWith("new-") && !r.id.startsWith("staff-")).map((r) => r.id),
  );
  const toDelete = existing.filter((e) => !kept.has(e.id));

  /**
   * Специалисты без учётной записи удалялись только с экрана.
   *
   * Удаление касалось лишь строк StaffUser, а специалист без входа — это
   * строка Staff. Крестик срабатывал, список перерисовывался — и после
   * сохранения человек возвращался: сервер его удаление просто не замечал.
   * Именно так вели себя все шесть демонстрационных специалистов, ни одного
   * из них убрать было нельзя.
   */
  const keptStaffIds = new Set(rows.map((r) => r.staffId).filter((id): id is string => Boolean(id)));
  const liveStaff = await prisma.staff.findMany({
    where: { companyId: session.companyId, deletedAt: null },
    select: { id: true, name: true, user: { select: { id: true, deletedAt: true } } },
  });
  const staffToDelete = liveStaff.filter(
    (s) =>
      !keptStaffIds.has(s.id) &&
      // Специалиста, за которым стоит живая учётка, удаляет она сама выше.
      !(s.user && s.user.deletedAt === null && kept.has(s.user.id)),
  );

  let cancelled = 0;
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
        cancelled += await cancelUpcoming(tx, session.companyId, del.staffId);
      }
    }

    for (const del of staffToDelete) {
      await tx.staff.update({
        where: { id: del.id },
        data: { deletedAt: new Date(), isActive: false, defaultRoomId: null },
      });
      cancelled += await cancelUpcoming(tx, session.companyId, del.id);
    }

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const name = r.name.trim();
      const base = {
        name,
        login: normalizeLogin(r.login),
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

      // Специалист без входа: обновляем только его карточку, учётку не заводим.
      if (r.id.startsWith("staff-") && !wantsLogin(r)) {
        if (r.staffId) await tx.staff.update({ where: { id: r.staffId }, data: specialistData });
        continue;
      }

      // Учётка.
      let userId = r.id;
      if (r.id.startsWith("new-") || r.id.startsWith("staff-")) {
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
  },
    // Запас по времени: значение по умолчанию — пять секунд, а каждый запрос
    // к удалённой базе идёт сотни миллисекунд. Сохранение сотрудников
    // обрывалось бы на середине, и человек видел бы, что записалась только
    // часть. Так уже случилось с базой знаний ассистента.
    { timeout: 120_000, maxWait: 10_000 },
  );

  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "accounts",
    meta: {
      count: rows.length,
      deleted: toDelete.length,
      specialistsDeleted: staffToDelete.length,
      appointmentsCancelled: cancelled,
    },
  });

  const removed = toDelete.length + staffToDelete.length;
  const notice =
    removed > 0
      ? `Удалено сотрудников: ${removed}` +
        (cancelled > 0 ? `; отменено будущих записей: ${cancelled}` : "")
      : undefined;
  return { ...(await getStaffPeople()), notice };
}
