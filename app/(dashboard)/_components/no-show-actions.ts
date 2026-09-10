"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { startOfClinicDay } from "@/lib/clinic-time";
import { predictNoShow, rememberPredictions } from "@/lib/server/no-show";

/**
 * Список «стоит подтвердить» на завтра.
 *
 * Считается на момент запроса: признаки меняются (пациент ответил, запись
 * перенесли), и хранимый список устарел бы молча. В журнал при этом ложится
 * то, что мы предсказали, — иначе через месяц не ответить, работает ли
 * функция вообще.
 */
export interface ConfirmRow {
  appointmentId: string;
  patientName: string;
  title: string;
  at: string;
  reasons: string[];
  /** Куда писать. Пусто — писать некуда, и в списке это сказано словами. */
  dialogId: string | null;
}

const TIME_FMT = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});

export async function confirmListAction(): Promise<ConfirmRow[]> {
  const session = await getSession();
  const start = startOfClinicDay(new Date(Date.now() + 24 * 3600 * 1000));
  const end = new Date(start.getTime() + 24 * 3600 * 1000);

  const { weights, rows } = await predictNoShow(session.companyId, start, end);
  // Веса не утверждены — прогноза нет вовсе, и выдумывать его нельзя.
  if (!weights) return [];

  await rememberPredictions(session.companyId, rows).catch(() => {
    // Журнал — для отчётности, а не для показа: его сбой список не отменяет.
  });

  const raised = rows.filter((r) => r.verdict.level === "raised" && r.reachable);
  if (raised.length === 0) return [];

  const dialogs = await prisma.conversation.findMany({
    where: {
      companyId: session.companyId,
      deletedAt: null,
      isPractice: false,
      patientId: { in: raised.map((r) => r.patientId) },
    },
    orderBy: { lastMessageAt: "desc" },
    select: { id: true, patientId: true },
  });
  const byPatient = new Map<string, string>();
  for (const d of dialogs) if (d.patientId && !byPatient.has(d.patientId)) byPatient.set(d.patientId, d.id);

  return raised.map((r) => ({
    appointmentId: r.appointmentId,
    patientName: r.patientName,
    title: r.title,
    at: TIME_FMT.format(r.startAt),
    reasons: r.verdict.reasons,
    dialogId: byPatient.get(r.patientId) ?? null,
  }));
}

/**
 * Отметить, что пациенту написали.
 *
 * По этой отметке считается польза функции: упала ли доля неявок среди тех,
 * кому написали. Без неё вопрос «работает ли» остаётся без ответа.
 */
export async function markContacted(appointmentId: string): Promise<void> {
  const session = await getSession();
  await prisma.noShowPrediction
    .updateMany({
      where: { appointmentId, companyId: session.companyId },
      data: { wasContacted: true },
    })
    .catch(() => {});
}


/**
 * Пометки риска для расписания: id записи → основание словами.
 *
 * Отдельным действием от списка «стоит подтвердить»: там завтрашний день и
 * действие «написать», здесь — любой день, который открыл администратор, и
 * только пометка. Ничего не блокируем и не мешаем работать.
 */
export async function noShowMarksAction(
  dayIso?: string,
): Promise<Record<string, string[]>> {
  const session = await getSession();
  const base = dayIso ? new Date(dayIso) : new Date();
  if (Number.isNaN(base.getTime())) return {};
  const start = startOfClinicDay(base);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);

  const { weights, rows } = await predictNoShow(session.companyId, start, end);
  if (!weights) return {};

  const marks: Record<string, string[]> = {};
  for (const r of rows) {
    if (r.verdict.level === "raised") marks[r.appointmentId] = r.verdict.reasons;
  }
  return marks;
}
