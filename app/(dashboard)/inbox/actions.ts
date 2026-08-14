"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { can } from "@/lib/server/authz";
import { inboxRecipients, notifyStaff } from "@/lib/server/notify";
import { humanTakeoverUntil } from "@/lib/agent/clinic-agent";
import { phoneFromChatId } from "@/lib/integrations/whatsapp/chat-id";
import { sendText as sendTelegram } from "@/lib/integrations/telegram/client";
import { sendText as sendWhatsapp } from "@/lib/integrations/whatsapp/green-api";
import { settingsStore, type TemplateItem } from "@/app/_data/settings";
import type { ConversationStatus } from "@/generated/prisma/enums";

/**
 * Утверждённые WhatsApp-шаблоны для инбокса — из сохранённых настроек (раздел
 * «Шаблоны»), а не из мок-стора. Вне 24-часового окна писать можно только ими.
 */
export interface ApprovedTemplate {
  id: string;
  title: string;
  body: string;
}

/** Быстрые ответы по умолчанию — те же, что предлагает раздел «Шаблоны». */
const DEFAULT_QUICK_REPLIES = [
  "Здравствуйте! Чем можем помочь?",
  "Подскажите ваш телефон для записи.",
  "Спасибо за обращение, хорошего дня!",
];

export interface InboxTemplates {
  approved: ApprovedTemplate[];
  /** Кнопки над полем ввода: вставляют текст, не отправляют его. */
  quickReplies: string[];
}

/**
 * Шаблоны и быстрые ответы для инбокса — из сохранённых настроек.
 *
 * Быстрые ответы были зашиты прямо в компоненте инбокса тремя строками:
 * раздел «Шаблоны» их сохранял, а диалог продолжал показывать свои. Человек
 * добавлял ответ и не понимал, куда тот делся.
 */
export async function getInboxTemplates(): Promise<InboxTemplates> {
  const session = await getSession();
  const row = await prisma.setting.findUnique({
    where: { companyId_key: { companyId: session.companyId, key: "templates" } },
  });
  const stored = row?.value as { templates?: TemplateItem[]; quickReplies?: string[] } | null;
  const templates = stored?.templates ?? settingsStore.templates;
  const quick = stored?.quickReplies?.filter((q) => q.trim().length > 0);

  return {
    approved: templates
      .filter((t) => t.status === "approved")
      .map((t) => ({ id: t.id, title: t.title, body: t.body })),
    quickReplies: quick && quick.length > 0 ? quick : DEFAULT_QUICK_REPLIES,
  };
}

/**
 * Диалоги инбокса — из доменных таблиц Conversation + Message.
 *
 * Состояние считается на сервере, а не в клиентском сторе: «непрочитано»,
 * причина эскалации и окно ответа раньше брались из мока и для диалогов из
 * базы всегда были пустыми — поэтому фильтр «Нужен ответ» показывал пусто,
 * даже когда пациент ждал ответа.
 */
export type DialogChannel = "instagram" | "whatsapp" | "telegram";
export type DialogStatus = "bot" | "escalated" | "human" | "closed";

/**
 * Вложение в переписке. Ссылка ведёт на /api/media, а не на файл провайдера:
 * прямая ссылка на голосовое пациента открыта любому, кто её увидел, а это
 * сведения о факте обращения за помощью (§7).
 */
export interface DialogAttachmentRecord {
  kind: string;
  label: string;
  /** Пусто, если файла нет: геопозиция, контакт. */
  href: string | null;
  mimeType?: string;
  fileName?: string;
  durationSec?: number;
}

export interface DialogMessageRecord {
  id: string;
  from: "patient" | "bot" | "staff";
  text: string;
  at: string;
  attachments: DialogAttachmentRecord[];
}

/** Вложения из JSON-поля сообщения в вид, пригодный для показа. */
function attachmentsOf(raw: unknown): DialogAttachmentRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: DialogAttachmentRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as {
      kind?: unknown;
      label?: unknown;
      mimeType?: unknown;
      fileName?: unknown;
      durationSec?: unknown;
      source?: { provider?: unknown; fileId?: unknown; url?: unknown };
    };
    if (typeof a.kind !== "string" || typeof a.label !== "string") continue;

    let href: string | null = null;
    const p = a.source?.provider;
    if (p === "TELEGRAM" && typeof a.source?.fileId === "string") {
      href = `/api/media?provider=TELEGRAM&ref=${encodeURIComponent(a.source.fileId)}`;
    } else if (p === "WHATSAPP" && typeof a.source?.url === "string") {
      href = `/api/media?provider=WHATSAPP&ref=${encodeURIComponent(a.source.url)}`;
    }

    out.push({
      kind: a.kind,
      label: a.label,
      href,
      mimeType: typeof a.mimeType === "string" ? a.mimeType : undefined,
      fileName: typeof a.fileName === "string" ? a.fileName : undefined,
      durationSec: typeof a.durationSec === "number" ? a.durationSec : undefined,
    });
  }
  return out;
}
export interface DialogRecord {
  id: string;
  name: string | null;
  patientId: string | null;
  channel: DialogChannel;
  /** Последнее слово за пациентом — диалог ждёт ответа. */
  unread: boolean;
  /** Почему диалог передан человеку. */
  escalationReason: string | null;
  /** Можно ли писать свободным текстом (24-часовое окно Instagram). */
  windowOpen: boolean;
  /** Сколько минут осталось до закрытия окна; null — окно без таймера. */
  windowMinutesLeft: number | null;
  /** Сколько сообщений в переписке всего: если больше загруженных — покажем. */
  totalMessages: number;
  status: DialogStatus;
  preview: string;
  at: string;
  messages: DialogMessageRecord[];
}

const STATUS_MAP: Record<ConversationStatus, DialogStatus> = {
  BOT_ACTIVE: "bot",
  ESCALATED: "escalated",
  HUMAN_TAKEOVER: "human",
  CLOSED: "closed",
};

const timeFmt = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});
const dateFmt = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  timeZone: "Europe/Moscow",
});

function atLabel(d: Date): string {
  const now = new Date();
  const day = 24 * 60 * 60 * 1000;
  const startToday = new Date(now);
  startToday.setHours(0, 0, 0, 0);
  if (d >= startToday) return timeFmt.format(d);
  if (d >= new Date(startToday.getTime() - day)) return "вчера";
  return dateFmt.format(d);
}

const CHANNEL_MAP: Record<string, DialogChannel> = {
  INSTAGRAM: "instagram",
  WHATSAPP: "whatsapp",
  TELEGRAM: "telegram",
};

const ESCALATION_LABEL: Record<string, string> = {
  AGENT_REQUEST: "агент позвал человека",
  PATIENT_REQUEST: "пациент просит человека",
  KEYWORD: "стоп-слово",
  MEDICAL_QUESTION: "медицинский вопрос",
  MISUNDERSTOOD: "агент не понял запрос",
  TIMEOUT: "агент долго молчал",
  OTHER: "другое",
};

/** Сколько последних сообщений диалога загружаем в инбокс. */
const MESSAGE_WINDOW = 100;

export async function getConversations(): Promise<DialogRecord[]> {
  const session = await getSession();
  const convs = await prisma.conversation.findMany({
    /**
     * Telegram в списке не показываем — решение заказчика.
     *
     * Бот в нём продолжает работать, переписка сохраняется и никуда не
     * девается: канал используется для проверок, и его диалоги мешали
     * администратору видеть обращения пациентов из WhatsApp. Чтобы вернуть —
     * достаточно убрать это условие.
     */
    where: { companyId: session.companyId, channel: { not: "TELEGRAM" } },
    orderBy: { lastMessageAt: "desc" },
    include: {
      patient: { select: { name: true } },
      // Последние сообщения, а не вся история: список обновляется каждые
      // несколько секунд, и тянуть переписку за год на каждый запрос нельзя.
      // Ничего не удаляется — просто не грузится лишнее.
      messages: {
        where: { deletedAt: null, isDraft: false },
        orderBy: { createdAt: "desc" },
        take: MESSAGE_WINDOW,
      },
      _count: { select: { messages: { where: { deletedAt: null, isDraft: false } } } },
      escalations: {
        where: { status: { not: "RESOLVED" } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { reason: true },
      },
    },
  });
  return convs.map((c) => {
    // Из базы пришли в обратном порядке (последние сверху) — разворачиваем.
    const ordered = [...c.messages].reverse();
    const messages: DialogMessageRecord[] = ordered.map((m) => ({
      id: m.id,
      from: m.authorType === "PATIENT" ? "patient" : m.authorType === "BOT" ? "bot" : "staff",
      text: m.body,
      at: atLabel(m.createdAt),
      attachments: attachmentsOf(m.attachments),
    }));
    const last = ordered[ordered.length - 1];
    // Ждёт ответа, если последним написал пациент и диалог не закрыт.
    const unread = last?.direction === "IN" && c.status !== "CLOSED";
    // Окно 24 часов — ограничение Instagram. В Telegram и WhatsApp его нет.
    const windowLeftMs = c.replyWindowExpiresAt ? c.replyWindowExpiresAt.getTime() - Date.now() : null;
    return {
      id: c.id,
      // Имя карточки важнее имени из профиля: карточку ведёт клиника.
      name: c.patient?.name ?? c.contactName ?? null,
      patientId: c.patientId,
      channel: CHANNEL_MAP[c.channel] ?? "whatsapp",
      status: STATUS_MAP[c.status],
      unread,
      escalationReason: c.escalations[0] ? ESCALATION_LABEL[c.escalations[0].reason] ?? null : null,
      windowOpen: c.channel !== "INSTAGRAM" || windowLeftMs === null || windowLeftMs > 0,
      windowMinutesLeft:
        c.channel === "INSTAGRAM" && windowLeftMs !== null && windowLeftMs > 0
          ? Math.round(windowLeftMs / 60000)
          : null,
      preview: last?.body ?? "",
      at: atLabel(c.lastMessageAt),
      totalMessages: c._count.messages,
      messages,
    };
  });
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

/**
 * Ответ администратора пациенту.
 *
 * Сообщение не только сохраняется, но и уходит в канал. Раньше оно просто
 * ложилось в базу: администратор писал, видел свой текст в переписке и был
 * уверен, что ответил, — а пациент не получал ничего.
 *
 * Instagram и WhatsApp пока не подключены (этап 2), поэтому там сообщение
 * помечается как неотправленное с честной причиной, а не тихо «отправляется».
 */
export async function sendMessageDb(
  conversationId: string,
  messageId: string,
  text: string,
): Promise<SendResult> {
  const session = await getSession();
  /**
   * Право «писать пациентам» настраивается по каждому сотруднику, но до сих
   * пор его соблюдал только интерфейс: кнопку прятали, а действие на сервере
   * работало у кого угодно. Отвечаем отказом текстом, а не исключением —
   * сообщение не должно исчезать в красном экране.
   */
  if (!(await can(session, "MESSAGE_PATIENTS"))) {
    return { ok: false, error: "Нет права писать пациентам" };
  }
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, companyId: session.companyId },
    select: { channel: true, externalUserId: true },
  });
  if (!conv) return { ok: false, error: "Диалог не найден" };

  const body = text.trim();
  let delivered = false;
  let failure: string | null = null;
  let externalId: string | null = null;

  if (conv.channel === "TELEGRAM") {
    const res = await sendTelegram(conv.externalUserId, body);
    if (res) {
      delivered = true;
      externalId = res.externalId;
    } else {
      failure = "Telegram не принял сообщение. Проверьте настройки бота.";
    }
  } else if (conv.channel === "WHATSAPP") {
    const res = await sendWhatsapp(session.companyId, conv.externalUserId, body);
    if (res.ok) {
      delivered = true;
      externalId = res.externalId ?? null;
    } else {
      // Причина от провайдера показывается как есть: «нет WhatsApp у номера»
      // и «номер не привязан» требуют разных действий от администратора.
      failure = `WhatsApp: ${res.error ?? "сообщение не отправлено"}`;
    }
  } else {
    failure = "Канал ещё не подключён — сообщение сохранено, но пациенту не ушло.";
  }

  await prisma.$transaction([
    prisma.message.create({
      data: {
        id: messageId,
        companyId: session.companyId,
        conversationId,
        channel: conv.channel,
        direction: "OUT",
        authorType: "STAFF",
        authorId: session.userId,
        body,
        externalId,
        status: delivered ? "SENT" : "FAILED",
        failureReason: failure,
        sentAt: delivered ? new Date() : null,
      },
    }),
    prisma.conversation.update({
      where: { id: conversationId },
      // Сотрудник ответил вручную — агент замолкает на 12 часов (§6.4).
      // Бот, перебивающий администратора, — худший баг в этой системе.
      data: { status: "HUMAN_TAKEOVER", lastMessageAt: new Date(), botPausedUntil: humanTakeoverUntil() },
    }),
  ]);

  // Диалог перешёл к человеку — остальным администраторам это важно знать,
  // чтобы двое не отвечали одному пациенту одновременно.
  await notifyStaff({
    companyId: session.companyId,
    recipientIds: await inboxRecipients(session.companyId, session.userId),
    kind: "PATIENT_MESSAGE",
    title: "Диалог взят в работу",
    body: "Коллега ответил пациенту вручную",
    url: "/inbox",
    entityId: conversationId,
  });

  return failure ? { ok: false, error: failure } : { ok: true };
}

/**
 * Вернуть диалог агенту. После ручного ответа агент молчит 12 часов (§6.4) —
 * это защита от бота, перебивающего администратора. Но без явной кнопки
 * диалог оставался немым до утра, и со стороны выглядело как «бот сломался».
 */
export async function returnToBotDb(conversationId: string): Promise<{ ok: true }> {
  const session = await getSession();
  await prisma.conversation.updateMany({
    where: { id: conversationId, companyId: session.companyId },
    data: { status: "BOT_ACTIVE", botPausedUntil: null },
  });
  await prisma.escalation.updateMany({
    where: { conversationId, status: { not: "RESOLVED" } },
    data: { status: "RESOLVED", resolvedAt: new Date(), resolvedById: session.userId },
  });
  return { ok: true };
}

/**
 * Переименовать контакт. Правит имя карточки, если диалог к ней привязан, и
 * имя из профиля — если ещё нет. Администратору всё равно, где оно лежит:
 * он видит одно имя и хочет его поправить.
 */
export async function renameContactDb(conversationId: string, name: string): Promise<{ ok: true }> {
  const session = await getSession();
  const clean = name.trim().slice(0, 120);
  if (!clean) throw new Error("Имя не может быть пустым");
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, companyId: session.companyId },
    select: { patientId: true },
  });
  if (!conv) throw new Error("Диалог не найден");
  if (conv.patientId) {
    await prisma.patient.update({ where: { id: conv.patientId }, data: { name: clean } });
  } else {
    await prisma.conversation.update({ where: { id: conversationId }, data: { contactName: clean } });
  }
  return { ok: true };
}

/**
 * Привязать диалог к карточке клиента: существующей или новой.
 *
 * Без этого переписка из мессенджера жила отдельно от базы клиентов —
 * администратор видел «Без имени» и не мог связать её с историей визитов.
 */
export async function linkPatientDb(
  conversationId: string,
  input: { patientId?: string; createName?: string },
): Promise<{ ok: true; patientId: string }> {
  const session = await getSession();
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, companyId: session.companyId },
    select: { id: true, contactName: true, sourceId: true, channel: true, externalUserId: true },
  });
  if (!conv) throw new Error("Диалог не найден");

  /**
   * Телефон из самого канала.
   *
   * В WhatsApp адрес чата и есть номер. Прежде он не использовался: карточка
   * создавалась без телефона, и постоянная пациентка получала вторую — а
   * ассистент разговаривал с ней как с незнакомой, потому что для него это
   * другой человек. Телефон — единственный надёжный ключ пациента (§4), и
   * если канал его знает, спрашивать заново незачем.
   */
  const channelPhone = conv.channel === "WHATSAPP" ? phoneFromChatId(conv.externalUserId) : null;

  let patientId = input.patientId ?? null;

  if (!patientId && channelPhone) {
    const existing = await prisma.patientPhone.findFirst({
      where: { companyId: session.companyId, phone: channelPhone },
      select: { patientId: true },
    });
    // Нашли по номеру — привязываем к ней, а не заводим вторую.
    if (existing) patientId = existing.patientId;
  }

  if (!patientId) {
    const name = (input.createName ?? conv.contactName ?? "").trim();
    if (!name) throw new Error("Укажите имя для новой карточки");
    const created = await prisma.patient.create({
      data: {
        companyId: session.companyId,
        name,
        firstSeenAt: new Date(),
        sourceId: conv.sourceId,
      },
      select: { id: true },
    });
    patientId = created.id;

    /**
     * Номер сохраняем сразу: карточка без телефона — это будущий дубль,
     * следующее обращение того же человека заведёт ещё одну.
     */
    if (channelPhone) {
      await prisma.patientPhone.create({
        data: {
          companyId: session.companyId,
          patientId,
          phone: channelPhone,
          isPrimary: true,
          usedForWhatsapp: true,
        },
      });
    }
  }

  await prisma.conversation.update({ where: { id: conversationId }, data: { patientId } });
  return { ok: true, patientId };
}

/** Пациенты для выбора при привязке диалога. */
export async function searchPatientsForLink(query: string): Promise<{ id: string; name: string; phone: string | null }[]> {
  const session = await getSession();
  const q = query.trim();
  const rows = await prisma.patient.findMany({
    where: {
      companyId: session.companyId,
      deletedAt: null,
      ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { phones: { some: { phone: { contains: q } } } }] } : {}),
    },
    orderBy: { name: "asc" },
    take: 15,
    select: { id: true, name: true, phones: { where: { isPrimary: true }, take: 1, select: { phone: true } } },
  });
  return rows.map((p) => ({ id: p.id, name: p.name ?? "Без имени", phone: p.phones[0]?.phone ?? null }));
}

export async function startDialogDb(input: {
  id: string;
  messageId: string;
  channel: DialogChannel;
  patientId: string | null;
  message: string;
}): Promise<void> {
  const session = await getSession();
  const channel = input.channel === "instagram" ? "INSTAGRAM" : "WHATSAPP";
  const now = new Date();
  await prisma.conversation.create({
    data: {
      id: input.id,
      companyId: session.companyId,
      patientId: input.patientId,
      channel,
      externalUserId: `local-${input.id}`,
      status: "HUMAN_TAKEOVER",
      // Пауза агента вместе со статусом: без неё «ручной режим» был только
      // подписью на экране, а бот продолжал отвечать в этом диалоге.
      botPausedUntil: humanTakeoverUntil(now),
      startedAt: now,
      lastMessageAt: now,
      messages: {
        create: {
          id: input.messageId,
          companyId: session.companyId,
          channel,
          direction: "OUT",
          authorType: "STAFF",
          authorId: session.userId,
          body: input.message.trim(),
        },
      },
    },
  });
}

