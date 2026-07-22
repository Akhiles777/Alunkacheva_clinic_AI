import type { VisitMix } from "./types";

/**
 * Классификация визитов пациента.
 *
 * Первичный  — первый в истории пациента ARRIVED-визит.
 * Повторный  — все последующие ARRIVED, и они бывают двух разных природ:
 *   COURSE_SESSION — сеанс внутри курса: пациент не «вернулся», он идёт по
 *                    уже оплаченной программе, это не новая лояльность;
 *   RETURN         — визит вне курса или после завершённого курса, то есть
 *                    настоящий возврат пациента.
 *
 * Функция чистая и работает по всей истории пациента: отменённый задним
 * числом визит убирает себя из истории, и первичным становится следующий.
 */

export type VisitKind = "FIRST" | "COURSE_SESSION" | "RETURN";

export interface VisitInput {
  appointmentId: string;
  startAt: Date;
  /** Учитываются только ARRIVED — остальные статусы историю не двигают. */
  status: "CREATED" | "CONFIRMED" | "ARRIVED" | "NO_SHOW" | "CANCELLED";
  courseId?: string | null;
}

export interface ClassifiedVisit {
  appointmentId: string;
  startAt: Date;
  kind: VisitKind | null;
}

/**
 * Раскладывает историю одного пациента по типам визитов.
 * Не-ARRIVED визиты возвращаются с kind = null: они не первичные и не
 * повторные, они просто ещё не состоялись (или уже не состоятся).
 */
export function classifyPatientVisits(visits: VisitInput[]): ClassifiedVisit[] {
  const ordered = [...visits].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());

  let seenArrived = false;

  return ordered.map((visit) => {
    if (visit.status !== "ARRIVED") {
      return { appointmentId: visit.appointmentId, startAt: visit.startAt, kind: null };
    }

    let kind: VisitKind;
    if (!seenArrived) {
      kind = "FIRST";
      seenArrived = true;
    } else {
      kind = visit.courseId ? "COURSE_SESSION" : "RETURN";
    }

    return { appointmentId: visit.appointmentId, startAt: visit.startAt, kind };
  });
}

/** Сводка по уже классифицированным визитам за период. */
export function summarizeVisitMix(kinds: (VisitKind | null)[]): VisitMix {
  const mix: VisitMix = { first: 0, courseSession: 0, returned: 0, total: 0 };

  for (const kind of kinds) {
    if (kind === "FIRST") mix.first += 1;
    else if (kind === "COURSE_SESSION") mix.courseSession += 1;
    else if (kind === "RETURN") mix.returned += 1;
    else continue;
    mix.total += 1;
  }

  return mix;
}

/** Доли для пропорциональной полосы. Сумма долей = 1 при total > 0. */
export function visitMixShares(mix: VisitMix): { first: number; courseSession: number; returned: number } {
  if (mix.total === 0) return { first: 0, courseSession: 0, returned: 0 };
  return {
    first: mix.first / mix.total,
    courseSession: mix.courseSession / mix.total,
    returned: mix.returned / mix.total,
  };
}
