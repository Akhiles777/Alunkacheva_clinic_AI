"use server";

import { prisma } from "@/lib/db";
import { startOfClinicDay } from "@/lib/clinic-time";
import { isNewInquiryWaiting } from "@/lib/inbox/needs-reply";
import { getSession } from "@/lib/server/session";
import { can, requirePermission } from "@/lib/server/authz";
import { escalationRecipients, inboxRecipients, notifyStaff } from "@/lib/server/notify";
import { humanTakeoverUntil } from "@/lib/agent/clinic-agent";
import { phoneFromChatId } from "@/lib/integrations/whatsapp/chat-id";
import { sendText as sendTelegram } from "@/lib/integrations/telegram/client";
import { sendText as sendWhatsapp } from "@/lib/integrations/whatsapp/green-api";
import { chatIdFromPhone } from "@/lib/integrations/whatsapp/chat-id";
import { settingsStore, type TemplateItem } from "@/app/_data/settings";
import type { ConversationStatus } from "@/generated/prisma/enums";
import { KIND_LABEL, type AttachmentKind } from "@/lib/agent/attachments";

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
function attachmentsOf(raw: unknown, messageId: string): DialogAttachmentRecord[] {
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
      /**
       * Ссылаемся на своё сообщение, а не на адрес провайдера.
       *
       * Адрес отдавался браузеру и возвращался обратно, а обработчик пускал
       * его по списку хостов. Файлы Green API лежат в другом хранилище, список
       * их резал, и голосовое молча не проигрывалось. Теперь адрес берётся из
       * базы по номеру сообщения — работает с любым хранилищем и не даёт
       * подставить чужой адрес.
       */
      href = `/api/media?provider=WHATSAPP&ref=${encodeURIComponent(messageId)}&i=${out.length}`;
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
  /** Номер, с которого пишет пациент. В WhatsApp он известен всегда. */
  phone: string | null;
  channel: DialogChannel;
  /** Последнее слово за пациентом — диалог ждёт ответа. */
  unread: boolean;
  /** Почему диалог передан человеку. */
  escalationReason: string | null;
  /** Можно ли писать свободным текстом (24-часовое окно Instagram). */
  /**
   * Агент выключен в этом диалоге насовсем — решением человека.
   *
   * Поле обязано доехать до экрана: список обновляется каждые несколько
   * секунд и пересобирает диалог по полям. Не перечисленное там теряется, и
   * кнопка возвращается в исходное сама, хотя в базе всё записано верно.
   */
  agentDisabled: boolean;
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
  // «Сегодня» и «вчера» — по времени клиники: сервер живёт по UTC, и три часа
  // каждой ночи сегодняшние сообщения подписывались вчерашним днём.
  const startToday = startOfClinicDay(now);
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

/**
 * Текст сообщения без наших пометок о вложении.
 *
 * В базе пометка нужна: без неё сообщение с одной фотографией выглядит пустым
 * в списке диалогов. Но в самой переписке вложение показано отдельной строкой
 * с кнопкой, и пациент видел «[фотография]» дважды подряд.
 */
function stripMarks(body: string, files: DialogAttachmentRecord[]): string {
  if (files.length === 0) return body;
  const marks = files
    .map((f) => `[${KIND_LABEL[f.kind as AttachmentKind] ?? f.label}]`)
    .join(" ");
  return (body.startsWith(marks) ? body.slice(marks.length) : body).trim();
}

/**
 * Привязать диалоги к карточкам по номеру из канала.
 *
 * Телефон — единственный надёжный ключ пациента (§4). Если номер уже есть в
 * базе, диалог должен относиться к той же карточке: иначе у человека их
 * становится две, а его история визитов не видна ни администратору, ни агенту.
 */
async function linkKnownPhones(
  companyId: string,
  convs: { id: string; externalUserId: string; phoneE164: string | null }[],
): Promise<void> {
  if (convs.length === 0) return;

  const byPhone = new Map<string, string[]>();
  for (const c of convs) {
    const phone = c.phoneE164 ?? phoneFromChatId(c.externalUserId);
    if (!phone) continue;
    const list = byPhone.get(phone);
    if (list) list.push(c.id);
    else byPhone.set(phone, [c.id]);
  }
  if (byPhone.size === 0) return;

  const known = await prisma.patientPhone.findMany({
    where: { companyId, phone: { in: [...byPhone.keys()] }, patient: { deletedAt: null } },
    select: { phone: true, patientId: true },
  });

  for (const row of known) {
    const ids = byPhone.get(row.phone);
    if (!ids?.length) continue;
    await prisma.conversation.updateMany({
      where: { id: { in: ids }, companyId, patientId: null },
      data: { patientId: row.patientId },
    });
  }
}

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
      patient: {
        select: {
          name: true,
          deletedAt: true,
          phones: { where: { isPrimary: true }, take: 1, select: { phone: true } },
        },
      },
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
  /**
   * Диалоги, привязанные к удалённой карточке.
   *
   * Карточку удаляют, а переписка остаётся: человек продолжает писать. Ссылка
   * при этом висит на несуществующей карточке — диалог выглядит привязанным, а
   * «Карточка клиента» открывает пустоту. Отвязываем: администратор привяжет к
   * правильной карточке. Само удаление теперь делает это сразу, здесь —
   * починка диалогов, осиротевших раньше.
   */
  /**
   * Диалог без карточки, но с известным номером.
   *
   * В WhatsApp адрес чата и есть телефон, и если такой пациент в базе уже есть,
   * привязка должна происходить сама: администратор не должен искать человека
   * руками, а агент — разговаривать с постоянным пациентом как с незнакомым.
   * Новые сообщения привязываются при обработке; здесь подхватываем диалоги,
   * заведённые раньше этого правила.
   */
  await linkKnownPhones(
    session.companyId,
    convs
      .filter((c) => !c.patientId && c.channel === "WHATSAPP")
      .map((c) => ({ id: c.id, externalUserId: c.externalUserId, phoneE164: c.phoneE164 })),
  );

  const orphaned = convs.filter((c) => c.patient?.deletedAt).map((c) => c.id);
  if (orphaned.length > 0) {
    await prisma.conversation.updateMany({
      where: { id: { in: orphaned }, companyId: session.companyId },
      data: { patientId: null },
    });
  }

  return convs.map((c) => {
    const patient = c.patient?.deletedAt ? null : c.patient;
    // Из базы пришли в обратном порядке (последние сверху) — разворачиваем.
    const ordered = [...c.messages].reverse();
    const messages: DialogMessageRecord[] = ordered.map((m) => {
      const files = attachmentsOf(m.attachments, m.id);
      return {
      id: m.id,
      from: m.authorType === "PATIENT" ? "patient" : m.authorType === "BOT" ? "bot" : "staff",
      // Пометку про вложение из текста убираем: файл показан отдельной строкой
      // рядом, и пациент видел «[фотография]» дважды.
      text: stripMarks(m.body, files),
      at: atLabel(m.createdAt),
      attachments: files,
      };
    });
    const last = ordered[ordered.length - 1];
    // Ждёт ответа, если пришло новое обращение и диалог не закрыт. Само
    // правило — в lib/inbox/needs-reply: там же оно проверено тестами.
    const newInquiry = isNewInquiryWaiting(
      ordered.map((m) => ({ direction: m.direction, createdAt: m.createdAt })),
    );

    const unread =
      last?.direction === "IN" &&
      c.status !== "CLOSED" &&
      newInquiry &&
      (c.staffReadAt === null || c.lastMessageAt > c.staffReadAt);
    // Окно 24 часов — ограничение Instagram. В Telegram и WhatsApp его нет.
    const windowLeftMs = c.replyWindowExpiresAt ? c.replyWindowExpiresAt.getTime() - Date.now() : null;
    return {
      id: c.id,
      // Имя карточки важнее имени из профиля: карточку ведёт клиника.
      name: patient?.name ?? c.contactName ?? null,
      patientId: patient ? c.patientId : null,
      // Карточка знает номер точнее: в неё его мог поправить администратор.
      /**
       * Номер: из карточки, из самого диалога, из адреса чата — в этом порядке.
       * Карточка точнее всего (её ведёт администратор), адрес чата — последний
       * шанс: в WhatsApp он теперь чаще всего скрытый и номера не содержит.
       */
      phone:
        patient?.phones[0]?.phone ??
        c.phoneE164 ??
        (c.channel === "WHATSAPP" ? phoneFromChatId(c.externalUserId) : null),
      channel: CHANNEL_MAP[c.channel] ?? "whatsapp",
      status: STATUS_MAP[c.status],
      unread,
      escalationReason: c.escalations[0] ? ESCALATION_LABEL[c.escalations[0].reason] ?? null : null,
      agentDisabled: c.agentDisabled,
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
    if (res.ok) {
      delivered = true;
      externalId = res.externalId ?? null;
    } else {
      // Причину показываем как есть: «bot was blocked» и «таймаут» требуют
      // от администратора разных действий.
      failure = res.error ?? "Telegram не принял сообщение. Проверьте настройки бота.";
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
      // Сотрудник ответил вручную — агент замолкает до возврата диалога (§6.4).
      // Бот, перебивающий администратора, — худший баг в этой системе.
      data: {
        status: "HUMAN_TAKEOVER",
        lastMessageAt: new Date(),
        botPausedUntil: humanTakeoverUntil(),
        // Сотрудник ответил — ожидание кончилось, напоминания начинаются заново.
        remindedAt: null,
        reminderCount: 0,
      },
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

/** Как часто из одного диалога можно звать администраторов вручную. */
const PING_COOLDOWN_MIN = 10;

/**
 * Позвать администраторов к диалогу — push прямо из переписки.
 *
 * Автоматическое напоминание уходит через полчаса ожидания и ровно один раз
 * (§6.4). Этого хватает не всегда: диалог видит владелец или коллега, пациент
 * ждёт, а полчаса ещё не прошли — и единственным способом растолкать было
 * позвонить. Кнопка делает это тем же путём, что и эскалация: push
 * администраторам, потому что отвечает пациенту администратор (§9).
 *
 * Отметка ожидания ставится та же, что у автоматического напоминания:
 * администраторам только что сказали, второй раз о том же говорить нельзя —
 * повторы перестают читать вместе со всем остальным.
 *
 * Повтор руками — не чаще чем раз в десять минут: кнопка, нажатая пять раз
 * подряд, превращается в тот же поток.
 */
export async function callAdminsDb(
  conversationId: string,
): Promise<{ ok: true; sent: number; pushed: number } | { ok: false; error: string }> {
  const session = await getSession();
  const now = new Date();

  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, companyId: session.companyId },
    select: {
      id: true,
      contactName: true,
      remindedAt: true,
      patient: { select: { name: true } },
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { direction: true, createdAt: true },
      },
    },
  });
  if (!conv) return { ok: false, error: "Диалог не найден" };

  if (conv.remindedAt && now.getTime() - conv.remindedAt.getTime() < PING_COOLDOWN_MIN * 60_000) {
    const ago = Math.round((now.getTime() - conv.remindedAt.getTime()) / 60_000);
    return {
      ok: false,
      error: `Администраторов уже позвали ${ago === 0 ? "только что" : `${ago} мин назад`}. Повторить можно через ${PING_COOLDOWN_MIN} мин.`,
    };
  }

  /**
   * Кто зовёт, тот push не получает: звать самого себя незачем. Если, кроме
   * него, администраторов нет, говорим это прямо, а не молча делаем вид, что
   * уведомление ушло.
   */
  const recipients = (await escalationRecipients(session.companyId)).filter(
    (id) => id !== session.userId,
  );
  if (recipients.length === 0) {
    return { ok: false, error: "Некого звать: других администраторов в клинике не заведено" };
  }

  const last = conv.messages[0];
  const who = conv.patient?.name?.trim() || conv.contactName?.trim() || "Пациент";
  const waitedMin =
    last && last.direction === "IN"
      ? Math.round((now.getTime() - last.createdAt.getTime()) / 60_000)
      : null;

  /** Имя зовущего: «просит ответить» без подписи выглядит как ещё один робот. */
  const caller = session.userId
    ? await prisma.staffUser.findUnique({
        where: { id: session.userId },
        select: { name: true },
      })
    : null;

  const { created, pushed } = await notifyStaff({
    companyId: session.companyId,
    recipientIds: recipients,
    kind: "ESCALATION",
    // Тело сообщения не пересказываем: в уведомления переписка не попадает (§7).
    title: waitedMin === null ? `${who} ждёт внимания` : `${who} ждёт ответа ${waitedMin} мин`,
    body: `${caller?.name?.trim() || "Коллега"} просит ответить пациенту`,
    url: "/inbox",
    entityId: conv.id,
  });

  /**
   * Ничего не создалось — значит и звать было некому.
   *
   * Уведомления об эскалации выключаются в «Настройки → Уведомления», и тогда
   * `notifyStaff` молча возвращает ноль. Отметить ожидание в этом случае
   * нельзя: она заблокирует и кнопку на десять минут, и автоматическое
   * напоминание — притом что администраторы ничего не получили.
   */
  if (created === 0) {
    return {
      ok: false,
      error:
        "Уведомление не ушло: в «Настройки → Уведомления» выключены оповещения об эскалации.",
    };
  }

  await prisma.conversation.update({
    where: { id: conv.id },
    data: { remindedAt: now, reminderCount: { increment: 1 } },
  });

  return { ok: true, sent: created, pushed };
}

/**
 * Вернуть диалог агенту. После ручного ответа агент молчит до срока возврата (§6.4) —
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
 * Выключить или включить агента в одном диалоге — насовсем.
 *
 * Пауза после перехвата истекает сама, и это правильно: пациент, которому не
 * ответили, дождётся хотя бы бота. Но в пациентский канал пишут и сотрудники
 * клиники между собой — «придёт Гулбарият, взять ОАК, оплату не брать», — и
 * агент отвечает им как пациенту, ничего не понимая. Отличить сотрудника от
 * пациента ему нечем, а человеку есть.
 *
 * Поэтому выключатель ставит человек, и срок у него не истекает: ни через
 * четыре часа, ни ночью. Включить обратно — той же кнопкой, и дальше всё
 * работает как раньше.
 */
export async function setAgentEnabledDb(
  conversationId: string,
  enabled: boolean,
): Promise<{ ok: true }> {
  const session = await getSession();
  await requirePermission(session, "MESSAGE_PATIENTS");
  await prisma.conversation.updateMany({
    where: { id: conversationId, companyId: session.companyId },
    data: enabled
      ? /**
         * Включаем — снимаем и паузу: администратор нажал кнопку осознанно,
         * заставлять его ждать ещё четыре часа незачем.
         */
        { agentDisabled: false, status: "BOT_ACTIVE", botPausedUntil: null }
      : { agentDisabled: true },
  });
  if (enabled) {
    await prisma.escalation.updateMany({
      where: { conversationId, status: { not: "RESOLVED" } },
      data: { status: "RESOLVED", resolvedAt: new Date(), resolvedById: session.userId },
    });
  }
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
      // Удалённая карточка номер за собой не держит, но проверяем и здесь:
      // привязать живой диалог к удалённому пациенту нельзя.
      where: { companyId: session.companyId, phone: channelPhone, patient: { deletedAt: null } },
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

/**
 * Отметить диалог прочитанным.
 *
 * Вызывается, когда сотрудник открыл переписку. Отдельным действием, а не
 * побочным эффектом загрузки списка: список тянется каждые несколько секунд у
 * всех сразу, и «прочитано» на нём означало бы, что диалоги гасятся сами собой,
 * пока их никто не видел.
 */
export async function markDialogReadDb(conversationId: string): Promise<{ ok: true }> {
  const session = await getSession();
  await prisma.conversation.updateMany({
    where: { id: conversationId, companyId: session.companyId },
    data: { staffReadAt: new Date() },
  });
  return { ok: true };
}

export interface StartDialogResult {
  ok: boolean;
  /** Диалог, в который легло сообщение: существующий или только что созданный. */
  dialogId: string | null;
  error?: string;
}

/**
 * Написать пациенту первым.
 *
 * Раньше эта функция ТОЛЬКО писала в базу: создавала диалог с выдуманным
 * адресом `local-…` и сохраняла исходящее сообщение, которого пациент никогда
 * не видел. Экран показывал «Сообщение отправлено», в «Диалогах» появлялась
 * переписка, а в WhatsApp не уходило ничего. Хуже, чем ошибка: система
 * уверенно врала о выполненной работе.
 *
 * Теперь путь один и тот же для всех отправок:
 *
 *   — переписка с пациентом уже есть → пишем в неё через `sendMessageDb`,
 *     который отправляет провайдеру и честно возвращает отказ;
 *   — переписки нет и канал WhatsApp → отправляем по номеру из карточки и
 *     заводим диалог с настоящим адресом чата, чтобы ответ пациента попал в
 *     ту же переписку, а не завёл вторую;
 *   — переписки нет и канал Instagram → отказ словами. Первым там пишет
 *     пациент: Meta не даёт начать разговор, и делать вид, что дала, нельзя.
 */
export async function startDialogDb(input: {
  id: string;
  messageId: string;
  channel: DialogChannel;
  patientId: string | null;
  message: string;
}): Promise<StartDialogResult> {
  const session = await getSession();
  if (!(await can(session, "MESSAGE_PATIENTS"))) {
    return { ok: false, dialogId: null, error: "Нет права писать пациентам" };
  }

  const body = input.message.trim();
  if (!body) return { ok: false, dialogId: null, error: "Пустое сообщение" };
  if (!input.patientId) {
    return { ok: false, dialogId: null, error: "Не выбран пациент" };
  }

  const channel = input.channel === "instagram" ? "INSTAGRAM" : "WHATSAPP";

  /**
   * Существующая переписка — главный случай: из «Кому позвонить» и из курсов
   * пишут тем, с кем уже говорили. Второй диалог с тем же человеком в том же
   * канале означал бы, что ответ придёт в один, а история лежит в другом.
   */
  const existing = await prisma.conversation.findFirst({
    where: {
      companyId: session.companyId,
      patientId: input.patientId,
      channel,
      deletedAt: null,
      // Адреса `local-…` остались от прежнего поведения: отправить в них
      // нельзя, и переиспользовать их тоже нельзя.
      NOT: { externalUserId: { startsWith: "local-" } },
    },
    orderBy: { lastMessageAt: "desc" },
    select: { id: true },
  });

  if (existing) {
    const res = await sendMessageDb(existing.id, input.messageId, body);
    return { ok: res.ok, dialogId: existing.id, error: res.ok ? undefined : res.error };
  }

  if (channel === "INSTAGRAM") {
    return {
      ok: false,
      dialogId: null,
      error: "В Instagram первым пишет пациент — начать разговор оттуда нельзя.",
    };
  }

  /** Нового диалога в WhatsApp без номера не бывает: адресовать некуда. */
  const phone = await prisma.patientPhone.findFirst({
    where: { companyId: session.companyId, patientId: input.patientId },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    select: { phone: true },
  });
  const chatId = chatIdFromPhone(phone?.phone);
  if (!chatId) {
    return { ok: false, dialogId: null, error: "У пациента нет номера — писать некуда." };
  }

  const sent = await sendWhatsapp(session.companyId, chatId, body);
  if (!sent.ok) {
    /**
     * Не доставлено — диалога не заводим. Пустая переписка в списке читается
     * как «мы написали», хотя не написали: пусть лучше администратор увидит
     * причину и решит, звонить ли.
     */
    return { ok: false, dialogId: null, error: `WhatsApp: ${sent.error ?? "сообщение не отправлено"}` };
  }

  const now = new Date();
  /**
   * Гонка двух администраторов: пара (компания, канал, адрес) уникальна, и
   * второй create упал бы исключением, а сообщение к тому моменту уже ушло
   * пациенту. Ловим и кладём сообщение в диалог, который создал первый.
   */
  const created = await createDialogOrJoin({
    data: {
      id: input.id,
      companyId: session.companyId,
      patientId: input.patientId,
      channel,
      /**
       * Настоящий адрес чата, а не `local-…`: по нему вебхук найдёт ту же
       * переписку, когда пациент ответит. Пара (компания, канал, адрес)
       * уникальна — второй строки не появится.
       */
      externalUserId: chatId,
      phoneE164: phone?.phone ?? null,
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
          body,
          externalId: sent.externalId ?? null,
          status: "SENT",
          sentAt: now,
        },
      },
    },
    select: { id: true },
  });

  return { ok: true, dialogId: created.id };
}

/**
 * Создать диалог, а если такой уже завёлся параллельно — дописать сообщение в
 * него. Сообщение пациенту к этому моменту уже отправлено, и потерять его в
 * гонке нельзя.
 */
async function createDialogOrJoin(
  args: Parameters<typeof prisma.conversation.create>[0],
): Promise<{ id: string }> {
  try {
    return await prisma.conversation.create(args);
  } catch {
    const data = args.data as {
      companyId: string;
      channel: "WHATSAPP" | "INSTAGRAM";
      externalUserId: string;
      messages?: { create: Record<string, unknown> };
    };
    const existing = await prisma.conversation.findFirstOrThrow({
      where: {
        companyId: data.companyId,
        channel: data.channel,
        externalUserId: data.externalUserId,
      },
      select: { id: true },
    });
    if (data.messages?.create) {
      await prisma.message.create({
        data: { ...(data.messages.create as object), conversationId: existing.id } as never,
      });
    }
    return existing;
  }
}

