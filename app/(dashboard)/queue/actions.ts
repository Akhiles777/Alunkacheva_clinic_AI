"use server";

import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import { recordOutreach } from "@/lib/server/callback-queue";
import type { CandidateKind } from "@/lib/metrics/callback-queue";
import { requireId } from "@/lib/server/require-id";

/**
 * Отметить, что пациенту из очереди написали.
 *
 * Нужна, чтобы честно посчитать, что дал список: запись человека, которому
 * никто не звонил, — не заслуга очереди. Без отметки раздел приписывал бы
 * себе весь поток клиники и всегда выглядел бы успешным.
 *
 * Отметка НЕ убирает человека из списка. Из очереди убирает только настоящая
 * будущая запись: «написали» — это ещё не «придёт».
 */
export async function noteOutreach(input: {
  patientId: string;
  kind: CandidateKind;
  basis: string;
  money: number | null;
}): Promise<void> {
  const session = await getSession();
  await requirePermission(session, "MESSAGE_PATIENTS");
  // Идентификатор пациента приходит снаружи: без него запись обращения ушла
  // бы в никуда, а отчёт «что дал список» посчитал бы его.
  requireId(input.patientId, "пациент");
  await recordOutreach({
    companyId: session.companyId,
    patientId: input.patientId,
    kind: input.kind,
    basis: input.basis,
    money: input.money,
    staffUserId: session.userId,
  });
}
