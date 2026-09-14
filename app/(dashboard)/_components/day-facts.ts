"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { countInquiriesFromDb } from "@/lib/metrics/inquiries";
import { clinicDayRange } from "@/lib/clinic-time";
import { visitTitle } from "@/lib/visit-title";
import { MOVES_TRACKING_KEY } from "@/lib/metrics/reschedule";
import {
  explainUnmarked,
  UNMARKED_LABEL,
  type KnownMove,
  type OtherBooking,
} from "@/lib/metrics/unmarked";

/**
 * Факты дня, которых нет в клиентском сторе.
 *
 * Обращения по §8 — это сообщения после суточной паузы, а не число диалогов:
 * посчитать их можно только по всей переписке, и делает это та же функция, что
 * и отчёты. Переносы — тем более серверные: их замечает выгрузка.
 *
 * Считаются на сервере ещё и потому, что на экране рядом стоят числа из
 * отчётов: своя арифметика в клиенте — прямой путь к двум правдам (§8).
 */

export interface MoveView {
  id: string;
  patientName: string;
  service: string;
  /** ISO — экран форматирует сам, ему виден часовой пояс. */
  fromAt: string;
  toAt: string;
  /**
   * Точный перенос или выведенный из пересоздания. На экране это разные
   * подписи: догадка не подаётся как факт.
   */
  exact: boolean;
}

/** Что известно про приём, оставшийся без отметки. */
export interface UnmarkedView {
  appointmentId: string;
  kind: string;
  label: string;
  reason: string;
  /** Куда перенесли — ISO, если знаем. */
  movedTo: string | null;
}

export interface DayFacts {
  dayKey: string;
  /** Обращения за день по определению §8. */
  inquiries: number;
  /** Записи, которые СТОЯЛИ на этот день и уехали на другое время. */
  moves: MoveView[];
  /** Разбор приёмов без отметки: перенос или забытая отметка. */
  unmarked: Record<string, UnmarkedView>;
  /**
   * С какого дня вообще ведётся счёт переносов. До него их не было не потому,
   * что не переносили, а потому что замечать было нечем: YCLIENTS о переносах
   * не сообщает, и восстановить их задним числом неоткуда.
   */
  movesSince: string | null;
}

export async function getDayFacts(dayKey: string): Promise<DayFacts> {
  const session = await getSession();
  const { start: from, end: to } = clinicDayRange(new Date(`${dayKey}T12:00:00Z`));

  /**
   * Переносы этого ДНЯ, а не переносы, замеченные в этот день.
   *
   * Вопрос заказчика был «кто перенёс запись, которая была на сегодня», и это
   * `fromStartAt` — время, на которое человек был записан. `detectedAt` отвечал
   * на другой вопрос — «когда выгрузка это увидела»: перенос вчерашней записи,
   * замеченный сегодня утром, попадал в сегодняшний день и был там не к месту.
   *
   * Записи, перенесённые НА этот день, отдельным числом больше не считаются
   * (решение заказчика, сентябрь 2026): они и так стоят в расписании дня
   * обычными приёмами, а число «приехало» рядом с «перенесли» только путало.
   */
  const [totals, moves, first] = await Promise.all([
    countInquiriesFromDb(session.companyId, from, to),
    prisma.appointmentMove.findMany({
      where: { companyId: session.companyId, fromStartAt: { gte: from, lt: to } },
      orderBy: { fromStartAt: "asc" },
      take: 50,
      select: {
        id: true,
        fromStartAt: true,
        toStartAt: true,
        exact: true,
        appointment: {
          select: {
            patient: { select: { name: true } },
            primaryService: { select: { title: true } },
            services: { select: { service: { select: { title: true } } } },
          },
        },
      },
    }),
    /**
     * С какого момента переносы действительно записываются — отметка
     * выгрузки, а не дата первого переноса: иначе «ноль переносов» не
     * показывался бы вовсе, а это тоже ответ.
     */
    prisma.setting.findUnique({
      where: { companyId_key: { companyId: session.companyId, key: MOVES_TRACKING_KEY } },
      select: { value: true },
    }),
  ]);

  /**
   * Приёмы этого дня, оставшиеся без отметки, и что про них известно.
   *
   * Разбираем ВСЕ незакрытые приёмы дня, а не только те, что экран уже назвал
   * неотмеченными: какие из них «прошли», решает экран по часам клиники, и
   * второе такое же правило здесь означало бы две правды об одном приёме (§8).
   */
  const planned = await prisma.appointment.findMany({
    where: {
      companyId: session.companyId,
      deletedAt: null,
      status: { in: ["CREATED", "CONFIRMED"] },
      startAt: { gte: from, lt: to },
    },
    select: { id: true, patientId: true, startAt: true, endAt: true },
  });

  const unmarked: Record<string, UnmarkedView> = {};
  if (planned.length > 0) {
    const patientIds = [...new Set(planned.map((p) => p.patientId).filter(Boolean))] as string[];
    /**
     * Другие записи тех же пациентов. Берём только будущие и недавно
     * заведённые: перенос — это запись, появившаяся ПОСЛЕ пропущенного приёма,
     * а старая история к нему отношения не имеет.
     */
    const others = patientIds.length
      ? await prisma.appointment.findMany({
          where: {
            companyId: session.companyId,
            deletedAt: null,
            patientId: { in: patientIds },
            status: { notIn: ["CANCELLED"] },
            createdAtYclients: { gte: from },
          },
          select: { id: true, patientId: true, startAt: true, createdAtYclients: true },
        })
      : [];

    const knownMoves: KnownMove[] = moves.map((m) => ({
      fromStartAt: m.fromStartAt,
      toStartAt: m.toStartAt,
      exact: m.exact,
    }));
    const now = new Date();

    for (const p of planned) {
      const mine: OtherBooking[] = others
        .filter((o) => o.patientId === p.patientId && o.id !== p.id)
        .map((o) => ({
          appointmentId: o.id,
          startAt: o.startAt,
          createdAt: o.createdAtYclients ?? o.startAt,
        }));
      const verdict = explainUnmarked(
        { appointmentId: p.id, patientId: p.patientId, startAt: p.startAt, endedAt: p.endAt },
        knownMoves,
        mine,
        now,
      );
      unmarked[p.id] = {
        appointmentId: p.id,
        kind: verdict.kind,
        label: UNMARKED_LABEL[verdict.kind],
        reason: verdict.reason,
        movedTo: verdict.movedTo?.toISOString() ?? null,
      };
    }
  }

  return {
    dayKey,
    inquiries: totals.total,
    unmarked,
    moves: moves.map((m) => ({
      id: m.id,
      patientName: m.appointment.patient?.name?.trim() || "Без имени",
      // Имя визита — это его состав, одной функцией на всю систему (§8).
      service: visitTitle(
        m.appointment.services.map((s) => ({ title: s.service.title })),
        m.appointment.primaryService?.title ?? "",
      ),
      fromAt: m.fromStartAt.toISOString(),
      toAt: m.toStartAt.toISOString(),
      exact: m.exact,
    })),
    movesSince: (first?.value as { since?: string } | null)?.since ?? null,
  };
}
