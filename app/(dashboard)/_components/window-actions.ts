"use server";

import { getSession } from "@/lib/server/session";
import { windowCandidates, windowStillFree, type WindowOffer } from "@/lib/server/window-candidates";
import { suggestAssembly, type AssemblySuggestion } from "@/lib/server/window-assembly";

/**
 * Кого позвать в свободное окно.
 *
 * Кандидаты — из очереди «Кому позвонить», проверки — в
 * `lib/metrics/window-fit.ts`. Ничего не бронируем: показываем, кому написать,
 * запись создаёт администратор.
 */
export async function windowCandidatesAction(input: {
  roomId: string;
  startAtIso: string;
  durationMin: number;
}): Promise<WindowOffer> {
  const session = await getSession();
  return windowCandidates(session.companyId, input);
}

/**
 * Не занято ли окно прямо сейчас.
 *
 * Спрашиваем ПЕРЕД действием, а не только при показе: пока администратор
 * смотрел на список, окно мог занять второй администратор или запись из
 * YCLIENTS. Предложить туда пациента после этого — подставить обоих.
 */
export async function windowStillFreeAction(input: {
  roomId: string;
  startAtIso: string;
  durationMin: number;
}): Promise<boolean> {
  const session = await getSession();
  const startAt = new Date(input.startAtIso);
  if (Number.isNaN(startAt.getTime())) return false;
  return windowStillFree(session.companyId, input.roomId, startAt, input.durationMin);
}


/**
 * Собрать окно под длинную услугу.
 *
 * Система только предлагает: перенос делает администратор, договорившись с
 * пациентом. Расписание перечитывается в момент запроса — между показом и
 * действием проходят минуты, а за минуту появляется чужая запись.
 */
export async function assemblyAction(input: {
  roomId: string;
  dayIso: string;
  needMin: number;
}): Promise<AssemblySuggestion[]> {
  const session = await getSession();
  if (!Number.isFinite(input.needMin) || input.needMin <= 0) return [];
  return suggestAssembly(session.companyId, input);
}
