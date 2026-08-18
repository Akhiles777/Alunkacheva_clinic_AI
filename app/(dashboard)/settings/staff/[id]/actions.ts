"use server";

import { prisma } from "@/lib/db";
import { averageCheck, noShowRate } from "@/lib/metrics/summary";
import { weekKeyOf, weekLabel as sharedWeekLabel } from "@/lib/metrics/types";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import { writeAudit } from "@/lib/server/audit";
import {
  ALL_PERMISSIONS,
  hasPermission,
  type Permission,
  type Role,
  type RolePermissionRow,
} from "@/lib/permissions";
import type { Permission as DbPermission, ServiceKind } from "@/generated/prisma/enums";
import { calcPayroll, type PayrollResult } from "@/lib/payroll/calc";

/**
 * Карточка сотрудника: персональные права и его работа в цифрах.
 *
 * Права — трёхпозиционные: «как у роли» (строки нет), «разрешено», «запрещено».
 * Так видно, что именно настроено лично, а что унаследовано, и роль остаётся
 * рабочей заготовкой.
 *
 * Метрики считаются по визитам привязанного специалиста. У администратора и
 * владельца специалиста нет — у них раздел приёмов пуст, и это нормально.
 */

/** null — наследуем право роли. */
export type PermissionSetting = boolean | null;

export interface StaffPermissionRow {
  permission: Permission;
  /** Что даёт роль сама по себе — показываем как подпись «как у роли». */
  fromRole: boolean;
  /** Персональное перекрытие или null. */
  personal: PermissionSetting;
  /** Итог, по которому реально пускает сервер. */
  effective: boolean;
}

export interface ServiceRow {
  service: string;
  count: number;
  revenue: number;
}

export interface WeekRow {
  label: string;
  appts: number;
  arrived: number;
  revenue: number;
}

export interface StaffMetrics {
  hasSpecialist: boolean;
  periodDays: number;
  appts: number;
  /**
   * Записи вперёд: их ещё не было, поэтому в показателях прошедшего периода
   * им не место, но и потеряться они не должны. Без этого числа новая запись
   * никак не отражалась на карточке специалиста — экран выглядел мёртвым.
   */
  upcoming: number;
  /** Ближайший визит — чтобы «запланировано» не было абстракцией. */
  nextVisitAt: string | null;
  arrived: number;
  noShow: number;
  cancelled: number;
  firstVisits: number;
  repeatVisits: number;
  uniquePatients: number;
  hours: number;
  revenue: number;
  avgCheck: number;
  noShowRatePct: number;
  arrivalRatePct: number;
  /** Доля от общей выручки клиники за период. */
  revenueSharePct: number;
  services: ServiceRow[];
  weeks: WeekRow[];
  lastVisitAt: string | null;
}

export interface PayoutRow {
  id: string;
  amount: number;
  reason: string | null;
  paidAt: string;
}

export interface PayrollView extends PayrollResult {
  hourlyRate: number;
  perProcedureRate: number;
  procedureKind: ServiceKind | null;
  procedures: number;
  /** Период расчёта — текущий календарный месяц. */
  periodLabel: string;
  /**
   * Выдачи за период — списком. Итоговая сумма без расшифровки не поддаётся
   * проверке: именно поэтому заказчик не мог понять, откуда берётся остаток.
   */
  payouts: PayoutRow[];
}

export interface StaffMemberView {
  id: string;
  /** Id карточки специалиста: к ней привязаны ставки и выплаты. */
  staffId: string | null;
  name: string;
  login: string;
  role: Role;
  isActive: boolean;
  specialty: string | null;
  roomName: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  permissions: StaffPermissionRow[];
  metrics: StaffMetrics;
  /** null — у сотрудника нет карточки специалиста, считать нечего. */
  payroll: PayrollView | null;
  /**
   * Есть ли у человека вход в систему. Медсёстры и часть специалистов заведены
   * без учётной записи — им нечего настраивать в правах, но ставки и расчёт
   * зарплаты нужны так же, как всем остальным.
   */
  hasAccount: boolean;
}

const PERIOD_DAYS = 90;

function weekKey(d: Date): number {
  const msk = new Date(d.getTime() + 3 * 3600 * 1000);
  const dow = (msk.getUTCDay() + 6) % 7;
  return Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate() - dow);
}
/**
 * Подпись недели — диапазоном, как и на графике владельца.
 *
 * Здесь стояла одна дата, «10.08». Ровно из-за такой подписи владелец сравнил
 * столбец графика с отчётом за «Неделю» и увидел 205 тысяч против 215: подпись
 * не говорила, за какой отрезок посчитано. У одной клиники подписи не должны
 * означать разное на разных экранах.
 */
function weekLabel(key: number): string {
  return sharedWeekLabel(weekKeyOf(new Date(key + 12 * 3600 * 1000)));
}

async function buildMetrics(companyId: string, staffId: string | null): Promise<StaffMetrics> {
  const empty: StaffMetrics = {
    hasSpecialist: false,
    periodDays: PERIOD_DAYS,
    appts: 0,
    upcoming: 0,
    nextVisitAt: null,
    arrived: 0,
    noShow: 0,
    cancelled: 0,
    firstVisits: 0,
    repeatVisits: 0,
    uniquePatients: 0,
    hours: 0,
    revenue: 0,
    avgCheck: 0,
    noShowRatePct: 0,
    arrivalRatePct: 0,
    revenueSharePct: 0,
    services: [],
    weeks: [],
    lastVisitAt: null,
  };
  if (!staffId) return empty;

  /**
   * Состоявшееся определяем по статусу, а не по времени.
   *
   * Сначала здесь не было верхней границы, и будущие записи считались
   * приёмами: у специалиста выходило 214 приёмов там, где состоялось 126.
   * Границу «только прошедшее» ставить тоже нельзя: администратор отмечает
   * «пришёл» в момент приёма, когда визит по расписанию ещё не закончился, —
   * и отметка не меняла ничего. Правильный признак один: ARRIVED и NO_SHOW —
   * это уже случившийся исход, CREATED и CONFIRMED — план.
   */
  const now = new Date();
  const since = new Date(now.getTime() - PERIOD_DAYS * 24 * 3600 * 1000);
  const [rows, clinicRevenue, upcomingRows] = await Promise.all([
    prisma.appointment.findMany({
      where: { companyId, deletedAt: null, staffId, startAt: { gte: since } },
      select: {
        startAt: true,
        durationMin: true,
        status: true,
        revenue: true,
        patientId: true,
        isFirstVisit: true,
        primaryService: { select: { title: true } },
      },
      orderBy: { startAt: "asc" },
    }),
    prisma.appointment.aggregate({
      where: { companyId, deletedAt: null, status: "ARRIVED", startAt: { gte: since } },
      _sum: { revenue: true },
    }),
    prisma.appointment.findMany({
      where: {
        companyId,
        deletedAt: null,
        staffId,
        // План — это то, у чего исход ещё не отмечен.
        status: { in: ["CREATED", "CONFIRMED"] },
        startAt: { gte: now },
      },
      orderBy: { startAt: "asc" },
      select: { startAt: true },
    }),
  ]);

  const arrivedRows = rows.filter((r) => r.status === "ARRIVED");
  const revenue = arrivedRows.reduce((sum, r) => sum + Number(r.revenue), 0);
  const noShow = rows.filter((r) => r.status === "NO_SHOW").length;
  const cancelled = rows.filter((r) => r.status === "CANCELLED").length;
  // Знаменатель для явки — только состоявшиеся исходы: отменённые визиты не
  // вина специалиста, иначе показатель врёт при массовых отменах.
  const settled = arrivedRows.length + noShow;
  const firstVisits = arrivedRows.filter((r) => r.isFirstVisit).length;
  const hours = arrivedRows.reduce((sum, r) => sum + r.durationMin, 0) / 60;
  const patients = new Set(arrivedRows.map((r) => r.patientId).filter(Boolean));
  const totalClinic = Number(clinicRevenue._sum.revenue ?? 0);

  const byService = new Map<string, { count: number; revenue: number }>();
  for (const r of arrivedRows) {
    const key = r.primaryService?.title ?? "Без услуги";
    const acc = byService.get(key) ?? { count: 0, revenue: 0 };
    acc.count += 1;
    acc.revenue += Number(r.revenue);
    byService.set(key, acc);
  }

  const byWeek = new Map<number, { appts: number; arrived: number; revenue: number }>();
  for (const r of rows) {
    const key = weekKey(r.startAt);
    const acc = byWeek.get(key) ?? { appts: 0, arrived: 0, revenue: 0 };
    acc.appts += 1;
    if (r.status === "ARRIVED") {
      acc.arrived += 1;
      acc.revenue += Number(r.revenue);
    }
    byWeek.set(key, acc);
  }

  return {
    hasSpecialist: true,
    periodDays: PERIOD_DAYS,
    /**
     * «Приёмы» — состоявшиеся, то есть ARRIVED (§8, «Пришедшие»).
     *
     * Здесь считались состоявшиеся плюс неявки, в кабинете владельца — все
     * визиты подряд, в отчётах — только пришедшие. Три числа под одним словом
     * у одного и того же специалиста. Неявки и отмены стоят рядом отдельными
     * числами: они отвечают на другие вопросы.
     */
    appts: arrivedRows.length,
    upcoming: upcomingRows.length,
    nextVisitAt: upcomingRows[0]?.startAt.toISOString() ?? null,
    arrived: arrivedRows.length,
    noShow,
    cancelled,
    firstVisits,
    repeatVisits: arrivedRows.length - firstVisits,
    uniquePatients: patients.size,
    hours: Math.round(hours * 10) / 10,
    revenue,
    avgCheck: averageCheck(revenue, arrivedRows.length),
    noShowRatePct: noShowRate(arrivedRows.length, noShow),
    arrivalRatePct: settled ? Math.round((arrivedRows.length / settled) * 100) : 0,
    revenueSharePct: totalClinic > 0 ? Math.round((revenue / totalClinic) * 100) : 0,
    services: [...byService.entries()]
      .map(([service, v]) => ({ service, ...v }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 8),
    weeks: [...byWeek.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(-8)
      .map(([key, v]) => ({ label: weekLabel(key), ...v })),
    lastVisitAt: arrivedRows.length ? arrivedRows[arrivedRows.length - 1].startAt.toISOString() : null,
  };
}

/**
 * Зарплата за текущий месяц. Часы берём по состоявшимся визитам, выплаты — по
 * отмеченным выдачам. Выплаты за процедуры вычитаются из начисленного: они
 * аванс, а не добавка (в этом и была ошибка прежней программы клиники).
 */
async function buildPayroll(companyId: string, staffId: string | null): Promise<PayrollView | null> {
  if (!staffId) return null;

  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const [rate, visits, payouts] = await Promise.all([
    prisma.staffRate.findUnique({
      where: { staffId },
      select: { hourlyRate: true, perProcedureRate: true, procedureKind: true },
    }),
    prisma.appointment.findMany({
      where: { companyId, staffId, deletedAt: null, status: "ARRIVED", startAt: { gte: from, lt: to } },
      select: { durationMin: true, primaryService: { select: { kind: true } } },
    }),
    prisma.payrollPayout.findMany({
      where: { companyId, staffId, paidAt: { gte: from, lt: to } },
      orderBy: { paidAt: "desc" },
      select: { id: true, amount: true, reason: true, paidAt: true },
    }),
  ]);

  const hourlyRate = Number(rate?.hourlyRate ?? 0);
  const perProcedureRate = Number(rate?.perProcedureRate ?? 0);
  const procedureKind = rate?.procedureKind ?? null;

  const workedMinutes = visits.reduce((sum, v) => sum + v.durationMin, 0);
  const procedures = procedureKind
    ? visits.filter((v) => v.primaryService?.kind === procedureKind).length
    : 0;
  // null — выдач не отмечали вовсе: тогда расчёт покажет ожидаемую сумму, а не
  // ноль, иначе остаток был бы завышен на всю выданную наличность.
  const paidSum = payouts.length === 0 ? null : payouts.reduce((sum, p) => sum + Number(p.amount), 0);

  const result = calcPayroll({ workedMinutes, hourlyRate, procedures, perProcedureRate, paidOut: paidSum });
  return {
    ...result,
    hourlyRate,
    perProcedureRate,
    procedureKind,
    procedures,
    periodLabel: new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" }).format(now),
    payouts: payouts.map((p) => ({
      id: p.id,
      amount: Number(p.amount),
      reason: p.reason,
      paidAt: p.paidAt.toISOString(),
    })),
  };
}

/** Ставки сотрудника. Меняет тот, кто ведёт настройки. */
export async function saveStaffRate(
  staffId: string,
  input: { hourlyRate: number; perProcedureRate: number; procedureKind: ServiceKind | null },
): Promise<PayrollView | null> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");
  await assertOwnStaff(session.companyId, staffId);
  if (!Number.isFinite(input.hourlyRate) || input.hourlyRate < 0) {
    throw new Error("Ставка за час должна быть числом не меньше нуля");
  }
  if (!Number.isFinite(input.perProcedureRate) || input.perProcedureRate < 0) {
    throw new Error("Ставка за процедуру должна быть числом не меньше нуля");
  }
  await prisma.staffRate.upsert({
    where: { staffId },
    update: {
      hourlyRate: input.hourlyRate,
      perProcedureRate: input.perProcedureRate,
      procedureKind: input.procedureKind,
    },
    create: {
      companyId: session.companyId,
      staffId,
      hourlyRate: input.hourlyRate,
      perProcedureRate: input.perProcedureRate,
      procedureKind: input.procedureKind,
    },
  });
  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "staff_rate",
    entityId: staffId,
    meta: { ...input },
  });
  // Возвращаем пересчитанный блок: смена ставки меняет и начисленное, и
  // остаток, и держать на экране прежние цифры нельзя.
  return buildPayroll(session.companyId, staffId);
}

/**
 * Специалист принадлежит этой клинике. Ставки и выплаты — деньги, и брать
 * идентификатор из формы на веру нельзя: без проверки можно было записать
 * выплату специалисту чужой компании.
 */
async function assertOwnStaff(companyId: string, staffId: string): Promise<void> {
  const staff = await prisma.staff.findFirst({
    where: { id: staffId, companyId, deletedAt: null },
    select: { id: true },
  });
  if (!staff) throw new Error("Специалист не найден");
}

/**
 * Отметить выдачу денег сотруднику в смену.
 *
 * Возвращает пересчитанный блок оплаты: раньше действие ничего не отдавало, и
 * экран просил «обновите страницу» — администратор не видел результата и мог
 * отметить выдачу дважды.
 */
export async function addPayout(
  staffId: string,
  amount: number,
  reason: string | null,
): Promise<PayrollView | null> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");
  await assertOwnStaff(session.companyId, staffId);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Сумма должна быть больше нуля");
  await prisma.payrollPayout.create({
    data: {
      companyId: session.companyId,
      staffId,
      amount,
      paidAt: new Date(),
      reason: reason?.trim() || null,
      createdById: session.userId,
    },
  });
  // Выдача денег — событие для аудита не меньше, чем правка настроек.
  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "payroll_payout",
    entityId: staffId,
    meta: { amount, reason: reason ?? null },
  });
  return buildPayroll(session.companyId, staffId);
}

/**
 * Отменить ошибочную выдачу.
 *
 * Без этого опечатка в сумме («5000» вместо «500») навсегда искажала остаток
 * к выплате, и исправить его было нечем — ровно та ситуация, из-за которой
 * заказчик не понимал, откуда берётся итог.
 */
export async function removePayout(payoutId: string): Promise<PayrollView | null> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");
  const row = await prisma.payrollPayout.findFirst({
    where: { id: payoutId, companyId: session.companyId },
    select: { id: true, staffId: true, amount: true },
  });
  if (!row) return null;
  await prisma.payrollPayout.delete({ where: { id: row.id } });
  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "payroll_payout_removed",
    entityId: row.staffId,
    meta: { amount: Number(row.amount) },
  });
  return buildPayroll(session.companyId, row.staffId);
}

/**
 * Карточка специалиста без учётной записи.
 *
 * Раньше карточка открывалась только для тех, у кого есть логин, — а ставки и
 * расчёт зарплаты живут именно в ней. Медсёстры заведены как специалисты без
 * входа, поэтому задать им 180 ₽/час и 500 ₽ за процедуру было физически
 * негде, хотя расчёт работал. Идентификатор такой строки — "staff-<id>",
 * ровно как в списке сотрудников.
 */
async function getSpecialistCard(
  companyId: string,
  staffId: string,
): Promise<StaffMemberView | null> {
  const staff = await prisma.staff.findFirst({
    where: { id: staffId, companyId, deletedAt: null },
    select: {
      id: true,
      name: true,
      specialty: true,
      isActive: true,
      createdAt: true,
      defaultRoom: { select: { name: true } },
    },
  });
  if (!staff) return null;

  return {
    id: `staff-${staff.id}`,
    staffId: staff.id,
    name: staff.name,
    login: "",
    role: "DOCTOR",
    isActive: staff.isActive,
    specialty: staff.specialty,
    roomName: staff.defaultRoom?.name ?? null,
    lastLoginAt: null,
    createdAt: staff.createdAt.toISOString(),
    permissions: [],
    metrics: await buildMetrics(companyId, staff.id),
    payroll: await buildPayroll(companyId, staff.id),
    hasAccount: false,
  };
}

export async function getStaffMember(id: string): Promise<StaffMemberView | null> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");

  if (id.startsWith("staff-")) {
    return getSpecialistCard(session.companyId, id.slice("staff-".length));
  }

  const user = await prisma.staffUser.findFirst({
    where: { id, companyId: session.companyId, deletedAt: null },
    select: {
      id: true,
      name: true,
      login: true,
      role: true,
      isActive: true,
      staffId: true,
      lastLoginAt: true,
      createdAt: true,
      staff: { select: { specialty: true, defaultRoom: { select: { name: true } } } },
      permissions: { select: { permission: true, allowed: true } },
    },
  });
  if (!user) return null;

  const roleRows = await prisma.rolePermission.findMany({
    where: { companyId: session.companyId },
    select: { role: true, permission: true, allowed: true },
  });
  const personal = new Map(user.permissions.map((p) => [p.permission as Permission, p.allowed]));

  const permissions: StaffPermissionRow[] = ALL_PERMISSIONS.map((permission) => {
    const fromRole = hasPermission(roleRows as RolePermissionRow[], user.role as Role, permission);
    const override = personal.has(permission) ? personal.get(permission)! : null;
    return {
      permission,
      fromRole,
      personal: override,
      effective: override === null ? fromRole : override,
    };
  });

  return {
    id: user.id,
    staffId: user.staffId,
    name: user.name,
    login: user.login,
    role: user.role as Role,
    isActive: user.isActive,
    specialty: user.staff?.specialty ?? null,
    roomName: user.staff?.defaultRoom?.name ?? null,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    permissions,
    metrics: await buildMetrics(session.companyId, user.staffId),
    payroll: await buildPayroll(session.companyId, user.staffId),
    hasAccount: true,
  };
}

export async function saveStaffPermissions(
  id: string,
  overrides: Record<string, PermissionSetting>,
): Promise<StaffMemberView | null> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");

  const user = await prisma.staffUser.findFirst({
    where: { id, companyId: session.companyId, deletedAt: null },
    select: { id: true, role: true },
  });
  if (!user) throw new Error("Сотрудник не найден");

  // Владельца нельзя лишить доступа к настройкам — иначе платформу уже никто
  // не откроет на редактирование.
  if (user.role === "OWNER" && overrides.EDIT_SETTINGS === false) {
    throw new Error("Владельцу нельзя запретить изменение настроек");
  }

  await prisma.$transaction(async (tx) => {
    for (const permission of ALL_PERMISSIONS) {
      const value = overrides[permission] ?? null;
      if (value === null) {
        await tx.userPermission.deleteMany({ where: { staffUserId: id, permission: permission as DbPermission } });
      } else {
        await tx.userPermission.upsert({
          where: { staffUserId_permission: { staffUserId: id, permission: permission as DbPermission } },
          update: { allowed: value },
          create: {
            companyId: session.companyId,
            staffUserId: id,
            permission: permission as DbPermission,
            allowed: value,
          },
        });
      }
    }
  },
    // Запас по времени: значение по умолчанию — пять секунд, а каждый запрос
    // к удалённой базе идёт сотни миллисекунд. Сохранение прав сотрудника
    // обрывалось бы на середине, и человек видел бы, что записалась только
    // часть. Так уже случилось с базой знаний ассистента.
    { timeout: 120_000, maxWait: 10_000 },
  );

  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "user_permissions",
    entityId: id,
    meta: { overrides },
  });

  return getStaffMember(id);
}
