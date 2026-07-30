"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import type { Appt } from "@/app/_data/store";
import { hypotheses, priceOf, roomLoad, staffPerformance } from "@/lib/staff-analytics";

/**
 * Серверный отчёт владельца — из БД (проекция Appointment + пациенты). Не мок:
 * данные персистентны, считаются на сервере. Когда подключим YCLIENTS (Этап 1),
 * та же проекция будет наполняться синком, а этот код не изменится.
 */
export interface OwnerStaffRow {
  name: string;
  appts: number;
  arrived: number;
  noShow: number;
  hours: number;
  revenue: number;
}
export interface OwnerRoomRow {
  name: string;
  ratePct: number;
}
export interface OwnerServiceRow {
  service: string;
  count: number;
  revenue: number;
}
export interface OwnerReport {
  revenue: number;
  appts: number;
  arrived: number;
  avgLoadPct: number;
  avgCheck: number;
  noShowRatePct: number;
  firstVisits: number;
  patients: { total: number; primary: number; noConsent: number };
  staff: OwnerStaffRow[];
  rooms: OwnerRoomRow[];
  services: OwnerServiceRow[];
  funnel: { dialogs: number; calls: number };
  hypotheses: string[];
}

const ROOM_KEY = (name: string): string =>
  name.startsWith("Кабинет 1") ? "room-1" : name.startsWith("Кабинет 2") ? "room-2" : "room-3";

const STATUS_MAP: Record<string, Appt["status"]> = {
  ARRIVED: "arrived",
  NO_SHOW: "no_show",
  CONFIRMED: "confirmed",
  CREATED: "planned",
};

/** Минута дня в таймзоне клиники по timestamptz. */
function minuteOfDay(at: Date, tz = "Europe/Moscow"): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}

async function loadAppts(companyId: string): Promise<Appt[]> {
  const rows = await prisma.appointment.findMany({
    where: { companyId, deletedAt: null, status: { not: "CANCELLED" } },
    include: {
      staff: { select: { name: true } },
      room: { select: { name: true } },
      primaryService: { select: { title: true } },
      patient: { select: { name: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    roomId: r.room ? ROOM_KEY(r.room.name) : "room-1",
    roomName: r.room?.name ?? "",
    doctor: r.staff.name,
    service: r.primaryService?.title ?? "",
    patientId: r.patientId,
    patientName: r.patient?.name ?? "",
    startMinute: minuteOfDay(r.startAt),
    durationMin: r.durationMin,
    status: STATUS_MAP[r.status] ?? "planned",
    isFirstVisit: r.isFirstVisit,
  }));
}

async function patientCounts(companyId: string) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const [total, primary, noConsent] = await Promise.all([
    prisma.patient.count({ where: { companyId, deletedAt: null } }),
    prisma.patient.count({ where: { companyId, deletedAt: null, firstSeenAt: { gte: startOfToday } } }),
    prisma.patient.count({
      where: { companyId, deletedAt: null, notes: { some: { kind: "NO_CONSENT", resolvedAt: null } } },
    }),
  ]);
  return { total, primary, noConsent };
}

function serviceBreakdown(appts: Appt[]): OwnerServiceRow[] {
  const map = new Map<string, OwnerServiceRow>();
  for (const a of appts) {
    const key = a.service || "—";
    const cur = map.get(key) ?? { service: key, count: 0, revenue: 0 };
    cur.count += 1;
    if (a.status === "arrived") cur.revenue += priceOf(a.service);
    map.set(key, cur);
  }
  return [...map.values()].sort((x, y) => y.revenue - x.revenue);
}

export async function getOwnerReport(): Promise<OwnerReport> {
  const session = await getSession();
  const [appts, patients, dialogs, calls] = await Promise.all([
    loadAppts(session.companyId),
    patientCounts(session.companyId),
    prisma.conversation.count({ where: { companyId: session.companyId } }),
    prisma.callLog.count({ where: { companyId: session.companyId } }),
  ]);

  const perf = staffPerformance(appts);
  const loads = roomLoad(appts);
  const revenueSum = perf.reduce((s, p) => s + p.revenue, 0);
  const arrived = appts.filter((a) => a.status === "arrived").length;
  const noShow = appts.filter((a) => a.status === "no_show").length;
  const avgLoadPct = loads.length
    ? Math.round((loads.reduce((s, l) => s + l.rate, 0) / loads.length) * 100)
    : 0;

  return {
    revenue: revenueSum,
    appts: appts.length,
    arrived,
    avgLoadPct,
    avgCheck: arrived > 0 ? Math.round(revenueSum / arrived) : 0,
    noShowRatePct: appts.length > 0 ? Math.round((noShow / appts.length) * 100) : 0,
    firstVisits: appts.filter((a) => a.isFirstVisit).length,
    patients,
    staff: perf.map((p) => ({
      name: p.name,
      appts: p.appts,
      arrived: p.arrived,
      noShow: p.noShow,
      hours: p.bookedMinutes / 60,
      revenue: p.revenue,
    })),
    rooms: loads.map((l) => ({ name: l.name, ratePct: Math.round(l.rate * 100) })),
    services: serviceBreakdown(appts),
    funnel: { dialogs, calls },
    hypotheses: hypotheses(appts),
  };
}

/** Текстовый срез базы для ИИ-аналитика владельца (только чтение). */
export async function getOwnerAiContext(): Promise<string> {
  const report = await getOwnerReport();
  const lines: string[] = [];
  lines.push("# Сводка клиники");
  lines.push(
    `Пациентов: ${report.patients.total} (первичных сегодня: ${report.patients.primary}, ` +
      `без согласия: ${report.patients.noConsent}).`,
  );
  lines.push(
    `Приёмов сегодня: ${report.appts} (пришли ${report.arrived}, первичных ${report.firstVisits}, ` +
      `неявки ${report.noShowRatePct}%). Выручка: ${report.revenue} ₽, средний чек ${report.avgCheck} ₽. ` +
      `Средняя загрузка кабинетов: ${report.avgLoadPct}%.`,
  );
  lines.push(`Воронка: диалогов ${report.funnel.dialogs}, звонков ${report.funnel.calls}.`);
  lines.push("");
  lines.push("# Выручка по услугам");
  for (const s of report.services) lines.push(`- ${s.service}: ${s.count} приёмов, ${s.revenue} ₽`);
  lines.push("");
  lines.push("# Сотрудники (сегодня)");
  for (const s of report.staff) {
    lines.push(
      `- ${s.name}: приёмов ${s.appts} (пришли ${s.arrived}, неявок ${s.noShow}); ` +
        `часы ${s.hours.toFixed(1)}; выручка ${s.revenue} ₽.`,
    );
  }
  lines.push("");
  lines.push("# Загрузка кабинетов");
  for (const r of report.rooms) lines.push(`- ${r.name}: ${r.ratePct}%.`);
  lines.push("");
  lines.push("# Уже замеченные гипотезы");
  for (const h of report.hypotheses) lines.push(`- ${h}`);
  return lines.join("\n");
}
