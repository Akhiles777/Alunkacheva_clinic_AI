"use server";

import { prisma } from "@/lib/db";
import { getSessionOrNull } from "@/lib/server/session";
import { startOfClinicDay } from "@/lib/clinic-time";
import { isFeature } from "@/lib/metrics/adoption";

/**
 * Счётчики того, чем пользуются.
 *
 * Считаем ЧИСЛА по дням и ничего больше: кто нажал, в каком диалоге и что
 * написал — не наше дело, и без этого в таблице нет ни персональных данных,
 * ни переписки (§7). Нужно ради одного честного ответа: что из сделанного
 * осталось невостребованным — шаблоны, клавиши, вложения.
 *
 * Ключи закрытым списком: неизвестное имя не пишется вовсе, иначе таблица
 * однажды наполнится случайными строками из опечаток.
 */
export async function noteUse(feature: string, times = 1): Promise<void> {
  if (!isFeature(feature)) return;
  const session = await getSessionOrNull();
  if (!session) return;
  const day = startOfClinicDay();
  const n = Math.min(Math.max(1, Math.round(times)), 50);
  await prisma.featureUse
    .upsert({
      where: { companyId_day_feature: { companyId: session.companyId, day, feature } },
      update: { count: { increment: n } },
      create: { companyId: session.companyId, day, feature, count: n },
    })
    // Счётчик не должен ронять действие, ради которого его завели.
    .catch(() => {});
}

export interface ProblemInput {
  text: string;
  screen?: string | null;
  lastError?: string | null;
  build?: string | null;
}

/**
 * Сообщить о проблеме одной кнопкой.
 *
 * Администратор не станет писать разработчику в мессенджер — он просто
 * перестанет пользоваться тем, что сломалось, и мы узнаем об этом через месяц
 * по косвенным признакам. Здесь он пишет фразу, а экран и последняя ошибка
 * добавляются сами: без них половина сообщений «не работает» неразбираема.
 *
 * В отчёт не попадает переписка: только путь экрана без параметров запроса —
 * в них живут идентификаторы пациентов.
 */
export async function reportProblem(input: ProblemInput): Promise<{ ok: boolean; error?: string }> {
  const session = await getSessionOrNull();
  if (!session) return { ok: false, error: "Нужен вход" };
  const text = input.text.trim();
  if (!text) return { ok: false, error: "Опишите, что случилось" };

  await prisma.problemReport.create({
    data: {
      companyId: session.companyId,
      authorId: session.userId,
      text: text.slice(0, 2000),
      screen: (input.screen ?? "").split("?")[0].slice(0, 200) || null,
      lastError: (input.lastError ?? "").slice(0, 500) || null,
      build: (input.build ?? "").slice(0, 100) || null,
    },
  });
  return { ok: true };
}

/** Разобрали — убираем из списка у владельца. Строка остаётся в базе. */
export async function resolveProblem(id: string): Promise<{ ok: boolean }> {
  const session = await getSessionOrNull();
  if (!session) return { ok: false };
  await prisma.problemReport.updateMany({
    where: { id, companyId: session.companyId },
    data: { resolvedAt: new Date() },
  });
  return { ok: true };
}
