"use server";

import { prisma } from "@/lib/db";
import { startOfClinicDay } from "@/lib/clinic-time";
import { isNewInquiryWaiting } from "@/lib/inbox/needs-reply";
import { getSession } from "@/lib/server/session";
import { can, requirePermission, type AuthzSubject } from "@/lib/server/authz";
import type { Role } from "@/lib/permissions";
import { escalationRecipients, inboxRecipients, notifyStaff } from "@/lib/server/notify";
import { humanTakeoverUntil } from "@/lib/agent/clinic-agent";
import { phoneFromChatId } from "@/lib/integrations/whatsapp/chat-id";
import {
  sendText as sendTelegram,
  sendTextReply as sendTelegramReply,
  sendFile as sendTelegramFile,
  deleteMessage as deleteTelegramMessage,
  editMessage as editTelegramMessage,
} from "@/lib/integrations/telegram/client";
import {
  sendText as sendWhatsapp,
  sendTextReply as sendWhatsappReply,
  sendFile as sendWhatsappFile,
  deleteMessage as deleteWhatsappMessage,
  editMessage as editWhatsappMessage,
} from "@/lib/integrations/whatsapp/green-api";
import { readStored } from "@/lib/media/store";
import { chatIdFromPhone } from "@/lib/integrations/whatsapp/chat-id";
import { fillTemplate, missingLabel } from "@/lib/message-template";
import { visitTitle } from "@/lib/visit-title";
import { listTemplates } from "@/lib/server/message-templates";
import type { ConversationStatus } from "@/generated/prisma/enums";
import { KIND_LABEL, type AttachmentKind } from "@/lib/agent/attachments";
import { splitQuote } from "@/lib/agent/quoted";
import { unreadCount, waitingSince } from "@/lib/inbox/waiting";
import { requireId } from "@/lib/server/require-id";

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

  /**
   * Шаблоны — из доменной таблицы, той же, что и в разделе настроек.
   *
   * Раньше инбокс читал их из JSON-настройки, а таблица под них пустовала:
   * добавить шаблон было нельзя вовсе. Быстрые ответы остаются настройкой —
   * они не про провайдера, а про поле ввода администратора.
   */
  const templates = await listTemplates(session.companyId);

  const row = await prisma.setting.findUnique({
    where: { companyId_key: { companyId: session.companyId, key: "templates" } },
  });
  const stored = row?.value as { quickReplies?: string[] } | null;
  const quick = stored?.quickReplies?.filter((q) => q.trim().length > 0);

  return {
    approved: templates
      .filter((t) => t.status === "approved")
      .map((t) => ({ id: t.id, title: t.title, body: t.body })),
    quickReplies: quick && quick.length > 0 ? quick : DEFAULT_QUICK_REPLIES,
  };
}

/**
 * Отправить пациенту шаблон.
 *
 * Отдельным действием, а не «отправить текст шаблона»: в шаблоне переменные, и
 * подставлять их надо на сервере, где есть карточка пациента и его запись.
 * Пока подстановки не было, кнопка отправляла текст как есть — пациент
 * получал «Здравствуйте, {{name}}! Напоминаем о визите {{date}} в {{time}}».
 *
 * Нечем заполнить — не отправляем вовсе и говорим, чего не хватает. Шаблон с
 * дырой хуже, чем не отправленный: он показывает, что клиника пишет роботом.
 */
/**
 * Подставить переменные шаблона по этому диалогу.
 *
 * Отдельной функцией, потому что ответ на один и тот же вопрос нужен дважды:
 * при отправке и в предпросмотре. Считать их по-разному — значит однажды
 * показать человеку один текст, а отправить другой.
 */
async function fillForDialog(
  companyId: string,
  conversationId: string,
  templateId: string,
): Promise<
  | { ok: true; text: string; title: string }
  | { ok: false; error: string }
> {
  const template = await prisma.messageTemplate.findFirst({
    where: { id: templateId, companyId },
    select: { bodyTemplate: true, status: true, title: true },
  });
  if (!template) return { ok: false, error: "Шаблон не найден" };
  if (template.status !== "APPROVED") {
    return { ok: false, error: `Шаблон «${template.title}» не согласован у провайдера` };
  }

  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, companyId },
    select: {
      patient: {
        select: {
          name: true,
          appointments: {
            where: { deletedAt: null, status: { notIn: ["CANCELLED", "NO_SHOW"] }, startAt: { gte: new Date() } },
            orderBy: { startAt: "asc" },
            take: 1,
            select: {
              startAt: true,
              staff: { select: { name: true } },
              primaryService: { select: { title: true } },
              services: { select: { service: { select: { title: true } } } },
            },
          },
        },
      },
      contactName: true,
      company: { select: { name: true } },
    },
  });
  if (!conv) return { ok: false, error: "Диалог не найден" };

  const next = conv.patient?.appointments[0];
  const filled = fillTemplate(template.bodyTemplate, {
    name: conv.patient?.name ?? conv.contactName,
    date: next ? DATE_FMT.format(next.startAt) : null,
    time: next ? TIME_FMT.format(next.startAt) : null,
    service: next
      ? visitTitle(
          next.services.map((x) => ({ title: x.service.title })),
          next.primaryService?.title ?? "приём",
        )
      : null,
    staff: next?.staff?.name ?? null,
    clinic: conv.company.name,
  });

  if (!filled.ok) {
    return {
      ok: false,
      error: `Не хватает данных для шаблона: ${missingLabel(filled.missing)}. Заполните их в карточке пациента или выберите другой шаблон.`,
    };
  }
  return { ok: true, text: filled.text, title: template.title };
}

/**
 * Предпросмотр: что именно уйдёт пациенту.
 *
 * Шаблон на экране — это заготовка с «{{name}}»; подставляет их сервер, у
 * которого есть карточка и ближайшая запись. Пока предпросмотра не было,
 * администратор нажимал кнопку вслепую и узнавал результат из переписки —
 * причём в половине случаев узнавал, что данных не хватило и ничего не ушло.
 */
export async function previewTemplateDb(
  conversationId: string,
  templateId: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  requireId(conversationId, "диалог");
  requireId(templateId, "шаблон");
  const session = await getSession();
  const filled = await fillForDialog(session.companyId, conversationId, templateId);
  return filled.ok ? { ok: true, text: filled.text } : { ok: false, error: filled.error };
}

export async function sendTemplateDb(
  conversationId: string,
  messageId: string,
  templateId: string,
): Promise<SendResult> {
  const session = await getSession();
  const filled = await fillForDialog(session.companyId, conversationId, templateId);
  if (!filled.ok) return { ok: false, error: filled.error };

  /**
   * Отметка использования — ради двух вещей сразу: частые шаблоны поднимаются
   * в списке сами, а не пользованные три месяца видно в настройках как
   * кандидатов на удаление. Считаем по факту ОТПРАВКИ, а не открытия списка:
   * посмотреть и передумать — это не «пользуются».
   */
  const sent = await sendMessageDb(conversationId, messageId, filled.text);
  if (sent.ok) {
    await prisma.messageTemplate.update({
      where: { id: templateId },
      data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
    });
  }
  return sent;
}


const DATE_FMT = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "numeric",
  month: "long",
});
const TIME_FMT = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  hour: "2-digit",
  minute: "2-digit",
});

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
  /**
   * Что с сообщением стало: отправляется, дошло, прочитано, не ушло.
   *
   * Только у своих: у сообщения пациента «доставлено» означало бы, что мы
   * отчитываемся о его телефоне, а мы о нём ничего не знаем.
   */
  delivery?: "sending" | "sent" | "delivered" | "read" | "failed";
  /** Почему не ушло — словами провайдера, без перевода в код. */
  failureReason?: string;
  /** Начало процитированного сообщения, если это ответ. */
  replyToPreview?: string;
  /** Текст правили после отправки. */
  edited?: boolean;
  /** Можно ли ещё удалить или исправить у пациента (окно провайдера). */
  canRecall?: boolean;
}

/**
 * Сколько времени сообщение можно отозвать или исправить у пациента.
 *
 * У мессенджеров свой срок, и он у каждого свой; берём общий разумный —
 * два часа. Кнопку, которая заведомо получит отказ провайдера, лучше не
 * показывать вовсе: человек нажмёт и решит, что платформа сломана.
 */
const RECALL_HOURS = 2;

function recallable(sentAt: Date): boolean {
  return Date.now() - sentAt.getTime() < RECALL_HOURS * 3600 * 1000;
}

/**
 * Состояние доставки одной строкой.
 *
 * Провайдер сообщает его вебхуком — sent / delivered / read; мы кладём отметки
 * времени и читаем их здесь. Пока отметок нет, но сообщение записано без
 * ошибки, честнее сказать «отправляется», чем «доставлено»: доставки мы ещё
 * не видели.
 */
function deliveryOf(m: {
  status: string;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
}): "sending" | "sent" | "delivered" | "read" | "failed" {
  if (m.status === "FAILED") return "failed";
  if (m.readAt) return "read";
  if (m.deliveredAt) return "delivered";
  if (m.sentAt) return "sent";
  return "sending";
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
      source?: { provider?: unknown; fileId?: unknown; url?: unknown; mediaId?: unknown };
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
    } else if (p === "LOCAL" && typeof a.source?.mediaId === "string") {
      // Наш собственный файл: лежит у нас на диске, отдаётся тем же адресом
      // и с той же проверкой входа и клиники.
      href = `/api/media?provider=LOCAL&ref=${encodeURIComponent(a.source.mediaId)}`;
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
  /**
   * До какого времени агент молчит после ответа сотрудника — «12:40».
   *
   * Пауза сама по себе правильная: бот не перебивает администратора. Но со
   * стороны она неотличима от поломки — владелец писал в диалог и делал
   * вывод, что бот не работает вовсе. Состояние должно быть видно на экране,
   * а не выясняться скриптом.
   */
  agentPausedUntil: string | null;
  windowOpen: boolean;
  /** Сколько минут осталось до закрытия окна; null — окно без таймера. */
  windowMinutesLeft: number | null;
  /** Сколько сообщений в переписке всего: если больше загруженных — покажем. */
  totalMessages: number;
  /**
   * С какого момента пациент ждёт ответа (ISO). Пусто — не ждёт.
   *
   * Список сортировался по времени последнего сообщения, и тот, кто ждёт
   * дольше всех, уезжал вниз под свежую переписку. Это разные вопросы, и
   * администратору нужен второй.
   */
  waitingSince: string | null;
  /** Сколько сообщений пациента сотрудник ещё не видел — как в мессенджере. */
  unreadCount: number;
  /** Первое обращение этого человека: с новым говорят иначе. */
  firstTime: boolean;
  /** Тренировочная переписка: наружу из неё ничего не уходит. */
  practice: boolean;
  /**
   * Назревшее напоминание по диалогу: «вернуться через два дня».
   *
   * Диалог всплывает в списке в назначенный момент — это и заменяет «не
   * забыть написать», которое сейчас теряется между сменами.
   */
  reminder: { id: string; body: string } | null;
  /** Сколько отложенных сообщений ждут отправки. */
  scheduled: number;
  /** Внутренних заметок по диалогу: их видно всем администраторам. */
  noteCount: number;
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
          /**
           * Состоявшиеся визиты — чтобы отличить первое обращение. С новым
           * человеком ещё ничего не связывает, и уходит он молча: в списке
           * он должен быть виден отдельно.
           */
          _count: { select: { appointments: { where: { status: "ARRIVED", deletedAt: null } } } },
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

  /**
   * Напоминания, заметки и отложенные — одним запросом на весь список.
   *
   * По одному на диалог это тридцать запросов каждые шесть секунд: список
   * тянется постоянно, и такая мелочь и есть то, из-за чего платформа
   * «долго грузит».
   */
  const ids = convs.map((c) => c.id);
  const [tasks, notes] = await Promise.all([
    ids.length
      ? prisma.dialogTask.findMany({
          where: { conversationId: { in: ids }, companyId: session.companyId, status: "PENDING" },
          select: { id: true, conversationId: true, kind: true, body: true, runAt: true },
        })
      : Promise.resolve([]),
    ids.length
      ? prisma.dialogNote.groupBy({
          by: ["conversationId"],
          where: { conversationId: { in: ids }, companyId: session.companyId, deletedAt: null },
          _count: { _all: true },
        })
      : Promise.resolve([]),
  ]);
  const nowMs = Date.now();
  const dueReminder = new Map<string, { id: string; body: string }>();
  const scheduledCount = new Map<string, number>();
  for (const t of tasks) {
    if (t.kind === "REMIND") {
      // Всплывает только назревшее: напоминание на послезавтра сегодня не
      // должно поднимать диалог наверх.
      if (t.runAt.getTime() <= nowMs && !dueReminder.has(t.conversationId)) {
        dueReminder.set(t.conversationId, { id: t.id, body: t.body });
      }
    } else {
      scheduledCount.set(t.conversationId, (scheduledCount.get(t.conversationId) ?? 0) + 1);
    }
  }
  const noteCount = new Map(notes.map((n) => [n.conversationId, n._count._all]));

  return convs.map((c) => {
    const patient = c.patient?.deletedAt ? null : c.patient;
    // Из базы пришли в обратном порядке (последние сверху) — разворачиваем.
    const ordered = [...c.messages].reverse();
    const messages: DialogMessageRecord[] = ordered.map((m) => {
      const files = attachmentsOf(m.attachments, m.id);
      const said = splitQuote(stripMarks(m.body, files));
      return {
      id: m.id,
      from: m.authorType === "PATIENT" ? "patient" : m.authorType === "BOT" ? "bot" : "staff",
      // Пометку про вложение из текста убираем: файл показан отдельной строкой
      // рядом, и пациент видел «[фотография]» дважды. Цитату — отдельно от
      // слов: свайпом пациент присылает две вещи сразу, и слитно это читается
      // как одно сплошное сообщение.
      text: said.own,
      at: atLabel(m.createdAt),
      attachments: files,
      /**
       * Состояние доставки — только у своих сообщений.
       *
       * У сообщения пациента «доставлено» означало бы, что мы отчитываемся о
       * его телефоне; мы о нём ничего не знаем и знать не можем.
       */
      delivery: m.direction === "OUT" ? deliveryOf(m) : undefined,
      failureReason: m.failureReason ?? undefined,
      replyToPreview: m.replyToPreview ?? said.quote ?? undefined,
      /**
       * `Boolean`, а не сравнение с null: поле может прийти неопределённым
       * (старый клиент Prisma в запущенном процессе), и `undefined !== null`
       * пометило бы «исправлено» каждое сообщение подряд — включая чужие.
       */
      edited: Boolean(m.editedAt),
      canRecall: m.direction === "OUT" && Boolean(m.externalId) && recallable(m.createdAt),
      };
    });
    const last = ordered[ordered.length - 1];
    /**
     * Очередь считаем по НЕудалённым сообщениям переписки: те же, что видит
     * администратор. Правила — в lib/inbox/waiting, там же тесты.
     */
    const queue = ordered.map((m) => ({ direction: m.direction, createdAt: m.createdAt }));
    const waiting = waitingSince(queue);
    /**
     * Первое обращение: у пациента нет ни одного состоявшегося визита и
     * переписка началась недавно. Незнакомого человека легко потерять — с ним
     * ещё ничего не связывает, и он уходит молча.
     */
    const firstTime = !patient || patient._count.appointments === 0;
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
      agentPausedUntil:
        c.botPausedUntil && c.botPausedUntil > new Date()
          ? timeFmt.format(c.botPausedUntil)
          : null,
      windowOpen: c.channel !== "INSTAGRAM" || windowLeftMs === null || windowLeftMs > 0,
      windowMinutesLeft:
        c.channel === "INSTAGRAM" && windowLeftMs !== null && windowLeftMs > 0
          ? Math.round(windowLeftMs / 60000)
          : null,
      /**
       * В списке — слова пациента, а не цитата, на которую он отвечал.
       * Иначе все ответы свайпом выглядят одинаково: «В ответ на: «Окошко на
       * завтра…»», и понять, кто чего хочет, по списку нельзя.
       */
      preview: last ? splitQuote(stripMarks(last.body, attachmentsOf(last.attachments, last.id))).own : "",
      at: atLabel(c.lastMessageAt),
      totalMessages: c._count.messages,
      practice: c.isPractice,
      reminder: dueReminder.get(c.id) ?? null,
      scheduled: scheduledCount.get(c.id) ?? 0,
      noteCount: noteCount.get(c.id) ?? 0,
      waitingSince: waiting ? waiting.toISOString() : null,
      unreadCount: unreadCount(queue, c.staffReadAt),
      firstTime,
      messages,
    };
  });
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

/** Где именно не получилось: у канала своя причина и своё действие. */
function whereFailed(channel: string, error?: string): string {
  if (channel === "WHATSAPP") return `WhatsApp: ${error ?? "сообщение не отправлено"}`;
  if (channel === "TELEGRAM") return error ?? "Telegram не принял сообщение. Проверьте настройки бота.";
  return error ?? "Сообщение не отправлено";
}

/**
 * Вид файла для провайдера. Стикер и всё непонятное уходит документом: это
 * честнее, чем выдать неизвестный файл за фотографию и получить отказ.
 */
function fileKindFor(kind: string): "photo" | "video" | "voice" | "audio" | "document" {
  if (kind === "photo" || kind === "video" || kind === "voice" || kind === "audio") return kind;
  return "document";
}

/**
 * Имя файла, когда его нет. Провайдер по имени и типу решает, чем показать
 * файл собеседнику, поэтому расширение важнее красоты.
 */
function defaultFileName(kind: string, mimeType: string): string {
  const ext = mimeType.split("/")[1]?.split(";")[0]?.replace(/[^a-z0-9]/gi, "") || "bin";
  if (kind === "voice") return `voice.${ext === "webm" ? "webm" : ext}`;
  if (kind === "photo") return `photo.${ext}`;
  if (kind === "video") return `video.${ext}`;
  return `file.${ext}`;
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
/**
 * Отправитель для фоновой работы — без сессии и без запроса.
 *
 * Роль берём из базы: расписание передаёт только идентификатор, а решать по
 * присланной роли значило бы, что фоновая ветка может назначить себе любые
 * права. Сотрудник уволен или выключен — отправителя нет, и сообщение не
 * уходит: у сообщения пациенту всегда есть автор.
 */
async function backgroundActor(
  companyId: string,
  userId: string | null,
): Promise<AuthzSubject | null> {
  if (!userId) return null;
  const user = await prisma.staffUser.findFirst({
    where: { id: userId, companyId, isActive: true },
    select: { id: true, role: true },
  });
  if (!user) return null;
  return { companyId, userId: user.id, role: user.role as Role };
}

export interface SendOptions {
  /** Файлы из хранилища (`/api/upload`), которые уходят вместе с сообщением. */
  mediaIds?: string[];
  /** Наше сообщение — ответ на это сообщение пациента (цитата в мессенджере). */
  replyToMessageId?: string | null;
  /**
   * От чьего имени отправляем, когда запроса нет.
   *
   * Отложенную отправку исполняет расписание внутри процесса, а не браузер:
   * там нет ни куки, ни сессии, и `getSession()` падал с «cookies was called
   * outside a request scope» — то есть обещанное пациенту на девять утра
   * сообщение молча оседало в «не ушло». Кто отправитель, известно из самой
   * задачи (`DialogTask.createdById`), и подставлять «никого» нельзя:
   * сообщение пациенту всегда чьё-то.
   */
  actorUserId?: string | null;
  companyId?: string;
}

export async function sendMessageDb(
  conversationId: string,
  messageId: string,
  text: string,
  options: SendOptions = {},
): Promise<SendResult> {
  /**
   * Кто отправляет. Из запроса — сессия; из расписания — сотрудник, который
   * эту отправку и назначил. Роль в обоих случаях читаем из базы, а не
   * доверяем вызывающему: иначе фоновая ветка стала бы обходом прав.
   */
  const session = options.companyId
    ? await backgroundActor(options.companyId, options.actorUserId ?? null)
    : await getSession();
  if (!session) return { ok: false, error: "Отправитель не найден — сообщение не ушло" };
  /**
   * Право «писать пациентам» настраивается по каждому сотруднику, но до сих
   * пор его соблюдал только интерфейс: кнопку прятали, а действие на сервере
   * работало у кого угодно. Отвечаем отказом текстом, а не исключением —
   * сообщение не должно исчезать в красном экране.
   *
   * Проверяется и у отложенной отправки, в момент ОТПРАВКИ: права могли
   * отобрать между «запланировал» и «ушло».
   */
  if (!(await can(session, "MESSAGE_PATIENTS"))) {
    return { ok: false, error: "Нет права писать пациентам" };
  }
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, companyId: session.companyId },
    select: { channel: true, externalUserId: true, isPractice: true },
  });
  if (!conv) return { ok: false, error: "Диалог не найден" };

  /**
   * Одно и то же сообщение дважды не отправляем.
   *
   * Идентификатор придумывает экран и присылает его сюда, поэтому повтор
   * узнаётся точно. Это нужно ровно в том случае, ради которого повтор и
   * существует: связь оборвалась на полпути, экран не дождался ответа и
   * пробует снова — а сообщение к тому времени уже ушло пациенту. Без этой
   * проверки он получил бы его второй раз, и виноватой выглядела бы клиника.
   */
  const already = await prisma.message.findUnique({
    where: { id: messageId },
    select: { id: true, status: true, failureReason: true },
  });
  if (already) {
    return already.status === "FAILED"
      ? { ok: false, error: already.failureReason ?? "Сообщение не ушло" }
      : { ok: true };
  }

  const body = text.trim();

  /**
   * Файлы берём из хранилища по идентификаторам, а не из тела запроса.
   *
   * Так браузер не пересылает байты второй раз, а сервер проверяет главное:
   * файл принадлежит этой клинике и ещё никуда не ушёл. Повторная отправка
   * одного и того же вложения означала бы, что пациент получит его дважды.
   */
  const media = options.mediaIds?.length
    ? await prisma.mediaFile.findMany({
        where: {
          id: { in: options.mediaIds },
          companyId: session.companyId,
          deletedAt: null,
          messageId: null,
        },
        select: {
          id: true,
          storageId: true,
          kind: true,
          mimeType: true,
          fileName: true,
          sizeBytes: true,
          durationSec: true,
        },
      })
    : [];

  if (options.mediaIds?.length && media.length !== options.mediaIds.length) {
    return { ok: false, error: "Вложение не найдено или уже отправлено — приложите файл заново." };
  }
  if (!body && media.length === 0) return { ok: false, error: "Пустое сообщение" };

  /**
   * Цитата: идентификатор у провайдера, а не наш.
   *
   * Мессенджер знает сообщение под своим номером; наш идентификатор ему ни о
   * чём не говорит. Сообщения без внешнего номера (черновик, сообщение,
   * которое не ушло) процитировать нельзя — отправляем без цитаты, а не
   * отказываем: ответ важнее оформления.
   */
  let replyToExternalId: string | null = null;
  let replyToPreview: string | null = null;
  if (options.replyToMessageId) {
    const quoted = await prisma.message.findFirst({
      where: {
        id: options.replyToMessageId,
        conversationId,
        conversation: { companyId: session.companyId },
        deletedAt: null,
      },
      select: { externalId: true, body: true },
    });
    replyToExternalId = quoted?.externalId ?? null;
    replyToPreview = quoted?.body?.slice(0, 160) ?? null;
  }

  let delivered = false;
  let failure: string | null = null;
  let externalId: string | null = null;

  /**
   * Каждый файл уходит отдельным сообщением — так устроены оба мессенджера.
   * Подпись достаётся первому: пациент читает её один раз, а не под каждой
   * фотографией. Если файлов нет, уходит обычный текст.
   */
  const sendOne = async (
    file: (typeof media)[number] | null,
    caption: string,
  ): Promise<{ ok: boolean; externalId?: string | null; error?: string }> => {
    if (conv.channel === "TELEGRAM") {
      if (!file) {
        const res = replyToExternalId
          ? await sendTelegramReply(conv.externalUserId, caption, replyToExternalId)
          : await sendTelegram(conv.externalUserId, caption);
        return { ok: res.ok, externalId: res.externalId, error: res.error };
      }
      const bytes = await readStored(file.storageId);
      if (!bytes) return { ok: false, error: "Файл пропал из хранилища" };
      const res = await sendTelegramFile({
        chatId: conv.externalUserId,
        kind: fileKindFor(file.kind),
        bytes,
        fileName: file.fileName ?? defaultFileName(file.kind, file.mimeType),
        mimeType: file.mimeType,
        caption,
        replyToExternalId,
      });
      return { ok: res.ok, externalId: res.externalId, error: res.error };
    }
    if (conv.channel === "WHATSAPP") {
      if (!file) {
        const res = replyToExternalId
          ? await sendWhatsappReply(session.companyId, conv.externalUserId, caption, replyToExternalId)
          : await sendWhatsapp(session.companyId, conv.externalUserId, caption);
        return { ok: res.ok, externalId: res.externalId, error: res.error };
      }
      const bytes = await readStored(file.storageId);
      if (!bytes) return { ok: false, error: "Файл пропал из хранилища" };
      const res = await sendWhatsappFile({
        companyId: session.companyId,
        phoneOrChatId: conv.externalUserId,
        bytes,
        fileName: file.fileName ?? defaultFileName(file.kind, file.mimeType),
        mimeType: file.mimeType,
        caption,
        quotedMessageId: replyToExternalId,
      });
      return { ok: res.ok, externalId: res.externalId, error: res.error };
    }
    return { ok: false, error: "Канал ещё не подключён" };
  };

  if (conv.isPractice) {
    /**
     * Тренировка: наружу не уходит ничего.
     *
     * Обрыв стоит ЗДЕСЬ, до провайдера, а не в интерфейсе: сотрудник учится
     * теми же кнопками, что и работает, и любая ветка, обошедшая экран
     * (отложенная отправка, шаблон, повтор), обязана упереться в ту же
     * проверку. Сообщение при этом сохраняется и видно в переписке — иначе
     * тренироваться не на чем.
     */
    delivered = true;
  } else if (conv.channel !== "TELEGRAM" && conv.channel !== "WHATSAPP") {
    failure = media.length
      ? "В этом канале файлы не отправляются."
      : "Канал ещё не подключён — сообщение сохранено, но пациенту не ушло.";
  } else if (media.length === 0) {
    const res = await sendOne(null, body);
    if (res.ok) {
      delivered = true;
      externalId = res.externalId ?? null;
    } else {
      // Причину показываем как есть: «bot was blocked», «нет WhatsApp у
      // номера» и «таймаут» требуют от администратора разных действий.
      failure = whereFailed(conv.channel, res.error);
    }
  } else {
    /**
     * Файлы отправляем по одному и останавливаемся на первой неудаче.
     *
     * Продолжать нельзя: пациент получил бы вторую фотографию без первой и
     * без подписи. Что успело уйти — сказано словами, иначе администратор
     * отправит всё заново и пациент получит дубли.
     */
    const sentIds: string[] = [];
    for (const [i, file] of media.entries()) {
      const res = await sendOne(file, i === 0 ? body : "");
      if (!res.ok) {
        failure = whereFailed(conv.channel, res.error);
        if (sentIds.length > 0) {
          failure += ` Уже ушло файлов: ${sentIds.length} из ${media.length} — отправьте только оставшиеся.`;
        }
        break;
      }
      sentIds.push(file.id);
      if (i === 0) externalId = res.externalId ?? null;
    }
    delivered = sentIds.length === media.length;
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
        /**
         * Ушло из платформы. Главная метрика цикла — какая доля ответов
         * уходит отсюда, а не из WhatsApp на телефоне клиники; отличать по
         * автору можно, но у сессии без сотрудника его нет, и факт надёжнее
         * вывода.
         */
        viaPlatform: true,
        /**
         * Вложения храним так же, как у пациента: один и тот же вид читает
         * один и тот же код показа. Свои файлы отличает `provider: "LOCAL"` —
         * они лежат у нас, а не у провайдера.
         */
        attachments: media.length
          ? media.map((f) => ({
              kind: f.kind,
              label: KIND_LABEL[f.kind as AttachmentKind] ?? "файл",
              mimeType: f.mimeType,
              fileName: f.fileName ?? undefined,
              durationSec: f.durationSec ?? undefined,
              sizeBytes: f.sizeBytes,
              source: { provider: "LOCAL", mediaId: f.id },
            }))
          : undefined,
        replyToId: options.replyToMessageId ?? null,
        replyToPreview,
      },
    }),
    ...(media.length
      ? [
          /**
           * Файл привязывается к сообщению: второй раз его не отправить, и
           * видно, куда он ушёл. Привязываем даже при неудаче — файл всё
           * равно принадлежит этой попытке, а повторную отправку человек
           * начинает заново, из предпросмотра.
           */
          prisma.mediaFile.updateMany({
            where: { id: { in: media.map((f) => f.id) }, companyId: session.companyId },
            data: { messageId },
          }),
        ]
      : []),
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

  // Тренировка коллег не касается: будить их учебным сообщением нельзя.
  if (conv.isPractice) return { ok: true };

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
 * Отправить ещё раз то, что не ушло.
 *
 * Повтор из готового сообщения, а не набор заново: текст и приложенные файлы
 * уже есть, и требовать от человека печатать всё снова из-за обрыва связи —
 * это перекладывать на него нашу неудачу. Сообщение обновляется на месте, а
 * не создаётся второе: в переписке не должно оставаться следа от попытки,
 * которая не состоялась.
 *
 * Повторяем только по-настоящему неудавшиеся: у отправленного повтор означал
 * бы второе сообщение пациенту.
 */
export async function resendMessageDb(messageId: string): Promise<SendResult> {
  requireId(messageId, "сообщение");
  const session = await getSession();
  if (!(await can(session, "MESSAGE_PATIENTS"))) {
    return { ok: false, error: "Нет права писать пациентам" };
  }
  const msg = await prisma.message.findFirst({
    where: { id: messageId, companyId: session.companyId, deletedAt: null },
    select: {
      id: true,
      status: true,
      direction: true,
      body: true,
      replyToId: true,
      conversationId: true,
    },
  });
  if (!msg) return { ok: false, error: "Сообщение не найдено" };
  if (msg.direction !== "OUT") return { ok: false, error: "Это сообщение пациента" };
  if (msg.status !== "FAILED") return { ok: true };

  /**
   * Файлы того сообщения отвязываем и прикладываем заново: отправка
   * принимает только неотправленные, а этот файл к пациенту так и не попал.
   */
  const files = await prisma.mediaFile.findMany({
    where: { messageId, companyId: session.companyId, deletedAt: null },
    select: { id: true },
  });
  await prisma.$transaction([
    ...(files.length
      ? [
          prisma.mediaFile.updateMany({
            where: { id: { in: files.map((f) => f.id) } },
            data: { messageId: null },
          }),
        ]
      : []),
    // Старую попытку убираем: вторая строка об одном сообщении в переписке
    // читается как два отправленных.
    prisma.message.delete({ where: { id: messageId } }),
  ]);

  return sendMessageDb(msg.conversationId, messageId, msg.body, {
    mediaIds: files.map((f) => f.id),
    replyToMessageId: msg.replyToId,
  });
}

/**
 * Удалить своё сообщение — и у нас, и у пациента.
 *
 * Главное правило: экран не должен расходиться с телефоном пациента. Если
 * провайдер отказался удалять (у мессенджеров на это есть срок), сообщение
 * остаётся на месте и человеку сказано почему — «убрать у себя» создало бы
 * две разные правды об одном разговоре, а пациент продолжил бы обсуждать
 * то, чего администратор больше не видит.
 *
 * Сообщение, которое не ушло, удаляется просто: у пациента его и не было.
 */
export async function deleteMessageDb(messageId: string): Promise<SendResult> {
  requireId(messageId, "сообщение");
  const session = await getSession();
  if (!(await can(session, "MESSAGE_PATIENTS"))) {
    return { ok: false, error: "Нет права писать пациентам" };
  }
  const msg = await prisma.message.findFirst({
    where: { id: messageId, companyId: session.companyId, deletedAt: null },
    select: {
      id: true,
      direction: true,
      externalId: true,
      channel: true,
      conversation: { select: { externalUserId: true } },
    },
  });
  if (!msg) return { ok: false, error: "Сообщение не найдено" };
  if (msg.direction !== "OUT") {
    // Сообщение пациента у него не удалить — это его сообщение.
    return { ok: false, error: "Сообщение пациента удалить нельзя." };
  }

  if (msg.externalId) {
    const res =
      msg.channel === "WHATSAPP"
        ? await deleteWhatsappMessage(session.companyId, msg.conversation.externalUserId, msg.externalId)
        : msg.channel === "TELEGRAM"
          ? await deleteTelegramMessage(msg.conversation.externalUserId, msg.externalId)
          : { ok: false, error: "В этом канале удаление не поддерживается" };
    if (!res.ok) {
      return {
        ok: false,
        error: `У пациента сообщение осталось: ${res.error ?? "провайдер отказал"}. Обычно это значит, что срок отзыва истёк.`,
      };
    }
  }

  await prisma.message.update({ where: { id: msg.id }, data: { deletedAt: new Date() } });
  return { ok: true };
}

/**
 * Исправить своё сообщение — и у нас, и у пациента.
 *
 * Та же оговорка, что у удаления: не согласился провайдер — текст остаётся
 * прежним у обоих. Правленое сообщение помечается `editedAt`: в переписке
 * видно, что текст меняли, иначе разговор выглядит так, будто администратор
 * писал именно это с самого начала.
 */
export async function editMessageDb(messageId: string, text: string): Promise<SendResult> {
  requireId(messageId, "сообщение");
  const session = await getSession();
  if (!(await can(session, "MESSAGE_PATIENTS"))) {
    return { ok: false, error: "Нет права писать пациентам" };
  }
  const body = text.trim();
  if (!body) return { ok: false, error: "Пустой текст" };

  const msg = await prisma.message.findFirst({
    where: { id: messageId, companyId: session.companyId, deletedAt: null },
    select: {
      id: true,
      direction: true,
      externalId: true,
      channel: true,
      attachments: true,
      conversation: { select: { externalUserId: true } },
    },
  });
  if (!msg) return { ok: false, error: "Сообщение не найдено" };
  if (msg.direction !== "OUT") return { ok: false, error: "Сообщение пациента править нельзя." };
  if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
    // Подпись у отправленного файла мессенджеры менять не дают.
    return { ok: false, error: "Сообщение с вложением исправить нельзя — удалите и отправьте заново." };
  }

  if (msg.externalId) {
    const res =
      msg.channel === "WHATSAPP"
        ? await editWhatsappMessage(session.companyId, msg.conversation.externalUserId, msg.externalId, body)
        : msg.channel === "TELEGRAM"
          ? await editTelegramMessage(msg.conversation.externalUserId, msg.externalId, body)
          : { ok: false, error: "В этом канале правка не поддерживается" };
    if (!res.ok) {
      return {
        ok: false,
        error: `У пациента текст прежний: ${res.error ?? "провайдер отказал"}. Обычно это значит, что срок правки истёк.`,
      };
    }
  }

  await prisma.message.update({
    where: { id: msg.id },
    data: { body, editedAt: new Date() },
  });
  return { ok: true };
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
  requireId(conversationId, "диалог");
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
  /**
   * Без идентификатора условие вырождается в «вся клиника».
   *
   * Выключение агента в одном диалоге погасило его во всех: фильтр был
   * написан верно, но `id: undefined` в Prisma не сужает выборку, а снимает
   * условие. Падение с внятной ошибкой лучше молчаливой правки всего.
   */
  requireId(conversationId, "диалог");
  await prisma.conversation.updateMany({
    where: { id: conversationId, companyId: session.companyId },
    data: enabled
      ? /**
         * Включаем — ждать ещё четыре часа незачем, но и переигрывать старую
         * переписку агент не должен.
         *
         * Раньше здесь стояло `botPausedUntil: null`, и это была дыра.
         * Граница, по которой добор отличает новое сообщение от старого, —
         * именно `botPausedUntil` (`needsAnswer`); сняв её, мы отдавали
         * добору последнее сообщение пациента, если ему меньше шести часов
         * (`MAX_AGE_HOURS`). Короткий круг ходит раз в три минуты — и через
         * 5–15 минут после включения агент писал пациенту ответ на реплику,
         * которую тот давно обсудил с администратором.
         *
         * Ставим границу «сейчас»: она уже в прошлом и ничего не задерживает,
         * но всё, что было до неё, остаётся за человеком. Ровно тот же приём,
         * которым пользуется автоматический возврат через четыре часа.
         */
        { agentDisabled: false, status: "BOT_ACTIVE", botPausedUntil: new Date() }
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

/**
 * Массовые действия по концу смены.
 *
 * Администратор закрывает смену, и в списке остаётся десяток разговоров, где
 * всё уже сказано: пациент поблагодарил, вопрос решён. По одному это десять
 * открытий переписки — ровно та работа, из-за которой список перестают
 * разбирать вовсе, и завтра он начинается грязным.
 *
 * Отметка прочтения и закрытие — разные вещи и разные кнопки. «Прочитано»
 * говорит «я это видел», «закрыт» — «разговор окончен»; смешивать их нельзя,
 * иначе закрытыми окажутся диалоги, которые просто просмотрели.
 */
export async function markDialogsReadDb(ids: string[]): Promise<{ ok: true; count: number }> {
  const session = await getSession();
  if (ids.length === 0) return { ok: true, count: 0 };
  const res = await prisma.conversation.updateMany({
    where: { id: { in: ids }, companyId: session.companyId },
    data: { staffReadAt: new Date() },
  });
  return { ok: true, count: res.count };
}

/**
 * Закрыть разговоры.
 *
 * Закрытие — не удаление: переписка остаётся, её видно фильтром «Закрытые» и
 * в карточке пациента, а новое сообщение пациента открывает диалог заново
 * (так работает вебхук). Поэтому кнопка не спрашивает подтверждения: цена
 * ошибки — один клик по фильтру.
 */
export async function closeDialogsDb(ids: string[]): Promise<{ ok: true; count: number }> {
  const session = await getSession();
  if (!(await can(session, "MESSAGE_PATIENTS"))) {
    return { ok: true, count: 0 };
  }
  if (ids.length === 0) return { ok: true, count: 0 };
  const now = new Date();
  const res = await prisma.conversation.updateMany({
    where: { id: { in: ids }, companyId: session.companyId, status: { not: "CLOSED" } },
    data: { status: "CLOSED", closedAt: now, staffReadAt: now },
  });
  /**
   * Открытые эскалации закрываем вместе с диалогом: иначе разговор закрыт, а
   * в «Срочных» он же висит — две правды об одном месте.
   */
  await prisma.escalation.updateMany({
    where: { conversationId: { in: ids }, companyId: session.companyId, status: { not: "RESOLVED" } },
    data: { status: "RESOLVED", resolvedAt: now, resolvedById: session.userId },
  });
  return { ok: true, count: res.count };
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

