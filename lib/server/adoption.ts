import { prisma } from "@/lib/db";
import { startOfClinicDay } from "@/lib/clinic-time";
import {
  FEATURES,
  firstReplyMinutes,
  median,
  platformShare,
  type OutgoingMessage,
  type ReplyEvent,
} from "@/lib/metrics/adoption";

/**
 * Переход в систему — числами, для кабинета владельца.
 *
 * Считаем по неделям: за день доля прыгает от одного разговора, а решение
 * «прижилось или нет» принимается по тренду. Всё считается теми же чистыми
 * функциями, что покрыты тестами (`lib/metrics/adoption.ts`), — здесь только
 * чтение из базы.
 */

const WEEK_MS = 7 * 24 * 3600 * 1000;

export interface AdoptionWeek {
  /** Подпись недели: «1–7 сент.» */
  label: string;
  ours: number;
  phone: number;
  share: number | null;
  /** Медиана времени первого ответа человека, минуты. */
  replyMinutes: number | null;
  dialogs: number;
}

export interface AdoptionView {
  weeks: AdoptionWeek[];
  /** Чем пользуются и что осталось невостребованным — за последние 30 дней. */
  features: { key: string; label: string; count: number }[];
  /** Сообщения о проблемах, ещё не разобранные. */
  problems: {
    id: string;
    text: string;
    screen: string | null;
    author: string | null;
    at: string;
  }[];
  /** С какого дня отметка «ушло из платформы» проставляется явно. */
  exactFrom: string;
}

const WEEK_FMT = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "Europe/Moscow" });
const AT_FMT = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});

/**
 * До этого дня признака `viaPlatform` в базе не было, и старые сообщения
 * различаются по автору. Дату показываем на экране: без неё рост доли можно
 * принять за успех, хотя изменился способ счёта.
 */
export const EXACT_FROM = new Date("2026-09-10T00:00:00Z");

export async function getAdoption(companyId: string, weeks = 6): Promise<AdoptionView> {
  const now = new Date();
  const from = new Date(startOfClinicDay(now).getTime() - (weeks - 1) * WEEK_MS);

  const [messages, problems, features] = await Promise.all([
    prisma.message.findMany({
      where: {
        companyId,
        createdAt: { gte: from },
        deletedAt: null,
        isDraft: false,
        // Тренировка — учёба сотрудника, а не работа с пациентами.
        conversation: { isPractice: false },
      },
      select: {
        createdAt: true,
        direction: true,
        authorType: true,
        authorId: true,
        viaPlatform: true,
        conversationId: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.problemReport.findMany({
      where: { companyId, resolvedAt: null },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        text: true,
        screen: true,
        createdAt: true,
        author: { select: { name: true } },
      },
    }),
    prisma.featureUse.groupBy({
      by: ["feature"],
      where: { companyId, day: { gte: new Date(now.getTime() - 30 * 24 * 3600 * 1000) } },
      _sum: { count: true },
    }),
  ]);

  const used = new Map(features.map((f) => [f.feature, f._sum.count ?? 0]));

  const buckets: AdoptionWeek[] = [];
  for (let i = 0; i < weeks; i++) {
    const start = new Date(from.getTime() + i * WEEK_MS);
    const end = new Date(start.getTime() + WEEK_MS);
    const inWeek = messages.filter((m) => m.createdAt >= start && m.createdAt < end);

    const outgoing: OutgoingMessage[] = inWeek
      .filter((m) => m.direction === "OUT")
      .map((m) => ({
        at: m.createdAt,
        viaPlatform: m.viaPlatform,
        authorId: m.authorId,
        fromBot: m.authorType === "BOT",
      }));

    /**
     * Время ответа считаем по каждому диалогу отдельно: события разных
     * переписок, слитые в один ряд, дали бы «ответ» одному пациенту на
     * сообщение другого.
     */
    const byDialog = new Map<string, ReplyEvent[]>();
    for (const m of inWeek) {
      const list = byDialog.get(m.conversationId) ?? [];
      list.push({
        at: m.createdAt,
        direction: m.direction === "IN" ? "IN" : "OUT",
        byStaff: m.authorType === "STAFF",
      });
      byDialog.set(m.conversationId, list);
    }
    const waits = [...byDialog.values()].flatMap((events) => firstReplyMinutes(events));

    const share = platformShare(outgoing);
    buckets.push({
      label: `${WEEK_FMT.format(start)} — ${WEEK_FMT.format(new Date(end.getTime() - 1))}`,
      ours: share.ours,
      phone: share.phone,
      share: share.share,
      replyMinutes: median(waits),
      dialogs: byDialog.size,
    });
  }

  return {
    weeks: buckets,
    features: FEATURES.map((f) => ({ ...f, count: used.get(f.key) ?? 0 })),
    problems: problems.map((p) => ({
      id: p.id,
      text: p.text,
      screen: p.screen,
      author: p.author?.name ?? null,
      at: AT_FMT.format(p.createdAt),
    })),
    exactFrom: WEEK_FMT.format(EXACT_FROM),
  };
}
