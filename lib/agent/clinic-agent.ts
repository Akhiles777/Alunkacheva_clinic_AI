import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { notifyStaff, escalationRecipients } from "@/lib/server/notify";
import { CLINIC_NAME } from "@/lib/brand";
import { getServices } from "./booking";
import { confidentMatch, matchKnowledge } from "./knowledge";
import { answerLLM, type Turn } from "./llm";
import { HANDOVER_REPLY, promisesBooking, promisesHuman } from "./booking-promise";
import { medical, personalTopic, scheduleTopic, wantsHuman } from "./triggers";
import {
  CONSENT_ACCEPT,
  CONSENT_DECLINE,
  consentRequestFor,
  grantConsent,
  materializeConsent,
} from "./consent";
import { shouldNotifyEscalation, type EscalationReason } from "./escalation-window";
import { consentFromText, isGreeting, menuActionFromText, supportsButtons } from "./text-actions";
import { messageBody, needsHuman, type IncomingAttachment } from "./attachments";
import { alreadyGreeted, alreadySaid } from "./repetition";
import { greetingText, withoutOffer } from "./greeting";
import { forMessenger } from "./messenger-text";
import { ungroundedNumbers } from "./grounding";
import { hasQuestion, inIntakeFlow, intakePrompt, looksLikeIntake, nameFromIntake } from "./intake";
import { stuckInMisunderstanding } from "./confusion";

/**
 * Агент пациентского канала.
 *
 * Разделение зон — решение заказчика (август 2026), см. §6 CLAUDE.md:
 *
 *   Отвечает сам: адрес, график, условия приёма, информация об услугах и ценах,
 *   согласие на обработку ПДн, условия отмены, подготовка и противопоказания.
 *   Передаёт человеку: свободные окна, запись, переносы и отмены, жалобы,
 *   уточнения по конкретному пациенту.
 *
 * То есть расписанием агент НЕ распоряжается: заказчик хочет, чтобы окна и
 * записи вёл администратор. Записи бот не создаёт.
 *
 * Жёсткие правила, нарушать нельзя:
 *   1. Медицинские темы — только дословным текстом из справочника клиники,
 *      который она завела и утвердила сама. Нет подходящей записи — вопрос
 *      уходит человеку. Своей медицинской эрудицией агент не пользуется.
 *   2. Ничего не выдумывать: цены, услуги, часы — только из базы.
 *   3. После перехвата человеком агент молчит, пока пауза не истечёт. Бот,
 *      перебивающий администратора, — худший баг в системе.
 */

/**
 * Пауза агента после того, как сотрудник ответил вручную (§6.4). Время, а не
 * флаг: пауза должна истекать сама, иначе диалог навсегда останется без бота.
 */
export const HUMAN_TAKEOVER_HOURS = 12;

export function humanTakeoverUntil(from: Date = new Date()): Date {
  return new Date(from.getTime() + HUMAN_TAKEOVER_HOURS * 3600 * 1000);
}

export interface AgentReply {
  text: string;
  buttons?: { text: string; data: string }[];
  /** Запросить номер телефона кнопкой Telegram. */
  askPhone?: boolean;
}

/**
 * Канал пациента. Бизнес-логика агента от него не зависит (§5): различаются
 * только доставка и кнопки, а правила ответа одни и те же.
 */
export type AgentChannel = "TELEGRAM" | "WHATSAPP" | "INSTAGRAM";

export interface AgentContext {
  companyId: string;
  channel: AgentChannel;
  externalUserId: string;
  displayName?: string | null;
}


// ─────────────────────────────────────────────── диалог

async function loadConversation(ctx: AgentContext) {
  const existing = await prisma.conversation.findFirst({
    where: { companyId: ctx.companyId, channel: ctx.channel, externalUserId: ctx.externalUserId },
  });
  if (existing) {
    // Имя в профиле могло измениться, а до привязки к карточке оно —
    // единственное, чем администратор отличает диалоги друг от друга.
    /**
     * Имя из профиля не затирает то, которым человек представился.
     *
     * Профиль подписан как «Ася» или вовсе «..», а для записи пациент назвал
     * ФИО целиком — и это имя нужнее и агенту, и администратору. Раньше каждое
     * следующее сообщение возвращало подпись из профиля, и названное ФИО
     * держалось до первой же реплики.
     */
    const words = (v: string) => v.trim().split(/\s+/).filter(Boolean).length;
    const keepKnown =
      existing.contactName && ctx.displayName && words(existing.contactName) > words(ctx.displayName);

    if (ctx.displayName && existing.contactName !== ctx.displayName && !keepKnown) {
      return prisma.conversation.update({
        where: { id: existing.id },
        data: { contactName: ctx.displayName },
      });
    }
    return existing;
  }

  // Источник обращения — по каналу: иначе вся воронка считала бы, что все
  // пациенты пришли из Telegram, и разрез по источникам врал бы (§8).
  const source = await prisma.source.findFirst({
    where: { companyId: ctx.companyId, code: ctx.channel.toLowerCase() },
    select: { id: true },
  });
  return prisma.conversation.create({
    data: {
      companyId: ctx.companyId,
      channel: ctx.channel,
      externalUserId: ctx.externalUserId,
      contactName: ctx.displayName ?? null,
      status: "BOT_ACTIVE",
      sourceId: source?.id ?? null,
      startedAt: new Date(),
      lastMessageAt: new Date(),
    },
  });
}

async function saveMessage(input: {
  companyId: string;
  conversationId: string;
  channel: AgentChannel;
  direction: "IN" | "OUT";
  authorType: "PATIENT" | "BOT" | "STAFF";
  body: string;
  externalId?: string | null;
  attachments?: IncomingAttachment[];
}) {
  await prisma.message.create({
    data: {
      companyId: input.companyId,
      conversationId: input.conversationId,
      channel: input.channel,
      direction: input.direction,
      authorType: input.authorType,
      body: input.body.slice(0, 4000),
      externalId: input.externalId ?? null,
      attachments: input.attachments?.length ? (input.attachments as unknown as object[]) : undefined,
    },
  });
  await prisma.conversation.update({
    where: { id: input.conversationId },
    data: {
      lastMessageAt: new Date(),
      ...(input.direction === "IN" ? { lastPatientMessageAt: new Date() } : {}),
    },
  });
}

/**
 * Передать диалог человеку. Повторно не эскалируем: пациент, который написал
 * три сообщения подряд, не должен создавать три эскалации и три push
 * администратору.
 */
async function escalate(companyId: string, conversationId: string, reason: EscalationReason, note: string) {
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { status: "ESCALATED" },
  });

  /**
   * Повторы гасим по времени последнего вызова, а не по статусу диалога.
   * Статус ESCALATED держится, пока сотрудник не вернёт диалог боту, и
   * прежняя проверка «уже эскалирован — выходим» означала, что после первого
   * же перевода просьбы позвать администратора не доходили никогда.
   */
  const last = await prisma.escalation.findFirst({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!shouldNotifyEscalation({ reason, lastEscalatedAt: last?.createdAt ?? null, now: new Date() })) {
    return;
  }

  await prisma.escalation.create({
    data: {
      companyId,
      conversationId,
      reason,
      urgency: reason === "MEDICAL_QUESTION" ? "HIGH" : "NORMAL",
      status: "OPEN",
    },
  }).catch(() => {});
  await notifyStaff({
    companyId,
    // Вызов человека будит только администраторов: отвечать пациенту им.
    recipientIds: await escalationRecipients(companyId),
    kind: "ESCALATION",
    title: "Диалог передан человеку",
    body: note,
    url: "/inbox",
    entityId: conversationId,
  });
}

// ─────────────────────────────────────────────── настройки ассистента

export interface AssistantMode {
  /** on — отвечает сам; drafts — только зовёт человека; off — молчит совсем. */
  mode: "on" | "off" | "drafts";
  greeting: string;
  stopWords: string[];
  /** Инструкция клиники: порядок разговора, что спрашивать при записи. */
  prompt: string;
}

const DEFAULT_MODE: AssistantMode = {
  mode: "on",
  greeting: "",
  stopWords: [],
  prompt: "",
};

/**
 * Режим и стоп-слова из «Настройки → Ассистент». Раньше переключатель в
 * интерфейсе ни на что не влиял: агент его просто не читал.
 */
async function assistantMode(companyId: string): Promise<AssistantMode> {
  try {
    const row = await prisma.setting.findUnique({
      where: { companyId_key: { companyId, key: "assistant" } },
      select: { value: true },
    });
    const cfg = (row?.value as { assistant?: Partial<AssistantMode> } | null)?.assistant;
    if (!cfg) return DEFAULT_MODE;
    return {
      mode: cfg.mode === "off" || cfg.mode === "drafts" ? cfg.mode : "on",
      greeting: typeof cfg.greeting === "string" ? cfg.greeting : "",
      stopWords: Array.isArray(cfg.stopWords) ? cfg.stopWords.filter((w) => typeof w === "string") : [],
      prompt: typeof cfg.prompt === "string" ? cfg.prompt : "",
    };
  } catch {
    return DEFAULT_MODE;
  }
}

function hitsStopWord(text: string, stopWords: string[]): boolean {
  const lower = text.toLowerCase();
  return stopWords.some((w) => w.trim().length > 2 && lower.includes(w.trim().toLowerCase()));
}

// ─────────────────────────────────────────────── справка из базы

/**
 * Справка клиники для модели.
 *
 * Раньше в промпт уходил ВЕСЬ справочник: у клиники 62 записи по 400 с лишним
 * символов — около 26 КБ на каждое сообщение пациента. Это и расход на модель,
 * и задержка ответа, и лишний шум, в котором нужный абзац теряется. Причём
 * растёт линейно: чем лучше клиника заполняет базу, тем дороже каждый ответ.
 *
 * Поэтому при заданном вопросе отбираем только подходящие записи. Без вопроса
 * (приветствие, кнопки) отдаём короткий набор: услуги, часы, адрес.
 */
/**
 * Восьми записей мало.
 *
 * Заказчик заметил, что ассистент «читает базу не полностью»: у клиники под
 * шесть десятков записей, а в промпт попадала горстка. Замер на боевом
 * провайдере показал, что длина справки на скорость ответа почти не влияет
 * (2 000 знаков — 3.4 с, 26 000 — 2.8 с), так что экономить тут было не на чем.
 * Ограничение осталось только против совсем уж длинных справок.
 */
const KNOWLEDGE_IN_PROMPT = 14;

/**
 * Предел справки в промпте по объёму, а не только по числу записей.
 *
 * Ограничения по количеству мало: записи бывают по полторы тысячи знаков.
 * Восемь таких — уже двенадцать килобайт, и модель отвечает медленнее, чем
 * ждёт вебхук. На бюджете в восемь тысяч знаков ответ укладывается в срок.
 */
const KNOWLEDGE_CHARS_BUDGET = 14000;

/**
 * Бюджет, когда подбор ничего не нашёл.
 *
 * Замер на боевом провайдере: справка в 26 000 знаков обрабатывается за 2.8 с —
 * столько же, сколько 2 000. То есть длина справки на скорость почти не влияет,
 * и жёстко резать её на непонятом вопросе незачем: восемь записей по алфавиту
 * ответа не дадут, и ассистент промолчит там, где мог бы помочь. Тратим больше
 * токенов ровно там, где иначе не ответим вовсе.
 */
const KNOWLEDGE_CHARS_FALLBACK = 20000;

async function clinicContext(companyId: string, question?: string): Promise<string> {
  const [services, knowledge, schedule, staff] = await Promise.all([
    getServices(companyId),
    prisma.knowledgeEntry.findMany({
      where: { companyId, isActive: true },
      select: { topic: true, question: true, answer: true },
    }),
    prisma.clinicSchedule.findMany({
      where: { companyId },
      orderBy: { weekday: "asc" },
      select: { weekday: true, startMinute: true, endMinute: true },
    }),
    /**
     * Кто принимает. Списка специалистов у агента не было вовсе, и на вопрос
     * «Ирина принимает?» он отвечал первой похожей записью справочника — про
     * авторскую программу с её именем. Пациентка спросила про врача, а
     * услышала про процедуру: имя совпало, ответ мимо.
     *
     * Имена и специальность — не медицинские данные и не персональные данные
     * пациента: это то же самое, что висит на двери кабинета.
     */
    prisma.staff.findMany({
      where: { companyId, isActive: true, deletedAt: null },
      orderBy: { name: "asc" },
      select: { name: true, specialty: true },
    }),
  ]);

  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const days = ["", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

  // Без разметки: этот текст и уходит в модель, и показывается пациенту.
  // Символы # и * в мессенджере выглядят как мусор.
  const lines = [`Клиника «${CLINIC_NAME}».`, "", "Услуги и цены:"];
  for (const s of services) lines.push(`• ${s.title} — ${s.price} ₽, ${s.durationMin} мин`);
  lines.push("", "Часы работы:");
  for (const d of schedule) lines.push(`${days[d.weekday]}: ${hhmm(d.startMinute)}–${hhmm(d.endMinute)}`);
  const closed = [1, 2, 3, 4, 5, 6, 7].filter((w) => !schedule.some((d) => d.weekday === w));
  if (closed.length) lines.push(`Выходной: ${closed.map((w) => days[w]).join(", ")}`);
  if (staff.length) {
    lines.push("", "Принимают:");
    for (const p of staff) lines.push(`• ${p.name}${p.specialty ? ` — ${p.specialty}` : ""}`);
  }
  const relevant = pickRelevant(knowledge, question);
  if (relevant.length) {
    lines.push("", "Справка клиники:");
    for (const k of relevant) lines.push(`${k.topic}: ${k.answer}`);
  }
  return lines.join("\n");
}

/**
 * Записи справочника, относящиеся к вопросу. Ранжируем тем же подбором, что
 * отвечает дословно, — разница лишь в пороге: сюда берём и неуверенные
 * совпадения, у модели есть контекст переписки, чтобы выбрать нужное.
 */
function pickRelevant(
  rows: { topic: string; question: string; answer: string }[],
  question?: string,
): { topic: string; question: string; answer: string }[] {
  const byScore = question
    ? rows
        .map((row) => ({ row, score: matchKnowledge(question, [row])?.score ?? 0 }))
        .sort((a, b) => b.score - a.score)
        .filter((x) => x.score > 0)
        .map((x) => x.row)
    : [];

  /**
   * Ничего не подошло — отдаём справочник целиком, ограничив лишь объёмом.
   *
   * Здесь стоял жёсткий предел в восемь записей, поставленный после случая,
   * когда пациент на «Добрый день» получил весь справочник простынёй. Предел
   * был лишним: тот случай вызвала не длина справки, а запасной путь, который
   * при неудачном ответе модели печатал пациенту сам контекст промпта. Его и
   * починили — теперь неудача ведёт к передаче человеку.
   *
   * Замер на боевом провайдере: 2 000 знаков — 3.4 с, 26 000 знаков — 2.8 с.
   * Длина справки на срок ответа не влияет, а вот восемь записей по алфавиту
   * вместо нужной означают «не знаю» там, где ответ в справочнике есть.
   */
  const matched = byScore.length > 0;
  const chosen = matched ? byScore : rows;
  const budget = matched ? KNOWLEDGE_CHARS_BUDGET : KNOWLEDGE_CHARS_FALLBACK;
  const limit = matched ? KNOWLEDGE_IN_PROMPT : rows.length;

  const result: { topic: string; question: string; answer: string }[] = [];
  let chars = 0;
  for (const row of chosen) {
    if (result.length >= limit) break;
    const size = row.topic.length + row.answer.length;
    if (chars + size > budget && result.length > 0) break;
    result.push(row);
    chars += size;
  }
  return result;
}

/**
 * Предыдущие реплики для модели.
 *
 * Берём переписку не только этого диалога, но и прежние обращения того же
 * пациента — если карточка привязана. Человек, который писал в клинику
 * месяц назад и вернулся, справедливо ждёт, что его помнят; для него это один
 * разговор, а не два. Прежде история ограничивалась текущим диалогом, и
 * постоянная пациентка получала ассистента, который её не знает.
 *
 * Ограничение по времени намеренное: переписка годичной давности к сегодняшнему
 * вопросу отношения не имеет, а место в промпте занимает.
 */
const HISTORY_DAYS = 60;

async function recentTurns(conversationId: string): Promise<Turn[]> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { patientId: true, companyId: true },
  });

  const since = new Date(Date.now() - HISTORY_DAYS * 24 * 3600 * 1000);
  const where = conv?.patientId
    ? {
        companyId: conv.companyId,
        conversation: { patientId: conv.patientId },
        createdAt: { gte: since },
        deletedAt: null,
        isDraft: false,
      }
    : { conversationId, deletedAt: null, isDraft: false };

  const rows = await prisma.message.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 21,
    select: { direction: true, body: true },
  });
  return rows
    .reverse()
    .slice(0, -1) // последнее — текущий вопрос, он передаётся отдельно
    .map((m) => ({ role: m.direction === "IN" ? ("user" as const) : ("assistant" as const), content: m.body }));
}

/**
 * Ответ бота всегда попадает в переписку. Раньше часть веток возвращала текст
 * пациенту, но не сохраняла его: в инбоксе диалог выглядел как молчание бота,
 * а администратор не понимал, что уже было сказано.
 */
async function respond(
  ctx: AgentContext,
  conversationId: string,
  reply: AgentReply,
): Promise<AgentReply> {
  const text = forMessenger(reply.text);
  await saveMessage({
    companyId: ctx.companyId,
    conversationId,
    channel: ctx.channel,
    direction: "OUT",
    authorType: "BOT",
    body: text,
  });
  return { ...reply, text };
}

// ─────────────────────────────────────────────── обработка

export async function handlePatientMessage(
  ctx: AgentContext,
  input: {
    text?: string;
    phone?: string;
    callbackData?: string;
    externalId?: string;
    /** Голосовые, фото, видео, документы — см. lib/agent/attachments.ts. */
    attachments?: IncomingAttachment[];
    /**
     * Номер, известный из самого канала. В WhatsApp он есть всегда: адрес
     * чата и есть телефон. Спрашивать его отдельно бессмысленно, а без
     * привязки диалог висит без карточки — администратор не видит ни истории
     * визитов, ни прошлых обращений.
     */
    knownPhone?: string | null;
  },
): Promise<AgentReply | null> {
  const conversation = await loadConversation(ctx);
  const attachments = input.attachments ?? [];
  const channelName =
    ctx.channel === "WHATSAPP" ? "WhatsApp" : ctx.channel === "INSTAGRAM" ? "Instagram" : "Telegram";

  /**
   * Когда агент молчит.
   *
   *   1. Сотрудник ответил вручную — пауза на 12 часов (§6.4).
   *   2. Диалог передан администратору, и вопрос снова из его зоны.
   *
   * Второе правило раньше было шире: любая открытая эскалация выключала агента
   * целиком. На живом диалоге это вышло так. Пациентка спросила про свободное
   * окно — вопрос администратора, агент передал его человеку. Следующей
   * репликой она написала «Расскажите», то есть попросила рассказать об
   * услугах, — и не получила ничего. Ответ был у агента под рукой, но он уже
   * молчал по всему диалогу.
   *
   * Теперь молчим только там, где решение за человеком: запись и расписание,
   * жалобы, прямая просьба позвать администратора. На справочные вопросы агент
   * продолжает отвечать, пока администратор занимается своим.
   *
   * Как только сотрудник ответил сам — замолкаем полностью (правило 1): двое
   * собеседников сразу хуже, чем один медленный.
   */
  const openEscalation =
    conversation.status === "ESCALATED"
      ? await prisma.escalation.findFirst({
          where: { conversationId: conversation.id, status: { not: "RESOLVED" } },
          select: { id: true },
        })
      : null;

  /**
   * Зона администратора: пока он ведёт диалог, эти темы — его.
   * Проверяем по тексту, а не по факту эскалации: справочный вопрос посреди
   * ожидания администратора агент отвечать обязан.
   */
  /**
   * Что действительно нельзя перебивать: просьбу позвать человека и жалобу.
   *
   * Запись сюда больше не входит. Пациентка написала «хотела бы записаться к
   * остеопату», а по диалогу уже висела эскалация — и агент промолчал. Ответил
   * он только со второго раза, на «Можно?». Со стороны это выглядит как
   * неисправность, а по сути мы бросаем клиента ровно там, где он готов
   * записаться: пока администратор освободится, агент должен вести человека
   * дальше — назвать услугу, цену и собрать данные. Времени он всё равно не
   * называет, так что помешать администратору нечем.
   */
  const askedForAdmin = personalTopic(input.text ?? "") || wantsHuman(input.text ?? "");

  const paused =
    (conversation.status === "HUMAN_TAKEOVER" &&
      conversation.botPausedUntil !== null &&
      conversation.botPausedUntil > new Date()) ||
    (openEscalation !== null && askedForAdmin);
  if (paused) {
    const pausedBody = messageBody(input.text ?? "", attachments);
    if (pausedBody) {
      await saveMessage({
        companyId: ctx.companyId,
        conversationId: conversation.id,
        channel: ctx.channel,
        direction: "IN",
        authorType: "PATIENT",
        body: pausedBody,
        externalId: input.externalId,
        attachments,
      });
      await notifyStaff({
        companyId: ctx.companyId,
        /**
         * Пока диалог ведёт человек, сообщения пациента — его дело.
         *
         * Прежде они уходили всем, у кого есть доступ к инбоксу, включая
         * владельца: он просил присылать вызовы администратора только
         * администраторам, а получал ещё и каждую реплику по переданному
         * диалогу. На десятке обращений в день это поток, который перестают
         * читать — и тогда теряется настоящее.
         */
        recipientIds: await escalationRecipients(ctx.companyId),
        kind: "PATIENT_MESSAGE",
        title: "Новое сообщение от пациента",
        // Без служебных пояснений про агента: сотруднику важно, что пациент
        // написал и ждёт ответа, а не в каком режиме сейчас бот.
        body: `Пациент написал в ${channelName}`,
        url: "/inbox",
        entityId: conversation.id,
      });
    }
    return null;
  }

  // ── нажатие кнопки
  if (input.callbackData) {
    return handleCallback(ctx, conversation.id, input.callbackData);
  }

  // ── контакт с номером
  if (input.phone) {
    return attachPhone(ctx, conversation.id, input.phone);
  }

  /**
   * Привязка карточки по номеру из канала.
   *
   * Молча и до разбора текста: пациенту об этом сообщать нечего, а
   * администратору карточка нужна с первого сообщения. Телефон — наш
   * единственный надёжный ключ пациента (§4).
   */
  if (input.knownPhone && !conversation.patientId) {
    await linkByPhone(ctx, conversation.id, input.knownPhone).catch(() => {});
  }

  const text = (input.text ?? "").trim();
  /**
   * Тело сообщения складывается из подписи пациента и пометок о вложениях.
   * Пустым оно бывает только у по-настоящему пустого update — раньше сюда же
   * попадали все голосовые и фотографии, и обращение терялось молча.
   */
  const body = messageBody(text, attachments);
  if (!body) return null;

  await saveMessage({
    companyId: ctx.companyId,
    conversationId: conversation.id,
    channel: ctx.channel,
    direction: "IN",
    authorType: "PATIENT",
    body,
    externalId: input.externalId,
    attachments,
  });

  /**
   * Согласие на обработку ПДн — до всего остального (§7). Спрашиваем один раз
   * за диалог; пока клиника не завела текст согласия, вопрос не задаётся.
   */
  const consent = await consentRequestFor(ctx.companyId, conversation.id);
  if (consent) {
    return respond(ctx, conversation.id, {
      text: consent.text + consentHint(ctx.channel),
      buttons: consent.buttons,
    });
  }

  /**
   * Ответ на вопрос о согласии словами.
   *
   * В WhatsApp кнопок нет, и до этой ветки согласие там нельзя было дать
   * вообще: вопрос задавался, ответить на него было нечем, а следующее
   * сообщение шло дальше как ни в чём не бывало. То есть переписка с
   * медицинской клиникой велась без зафиксированного согласия — прямое
   * нарушение §7.
   *
   * Слова принимаем только пока согласие ждём. Вне этого «да» в переписке
   * значит что угодно, и засчитать его за согласие было бы подлогом.
   */
  if (conversation.consentAskedAt && !conversation.consentGrantedAt) {
    const answer = consentFromText(text);
    if (answer) return handleCallback(ctx, conversation.id, answer);

    // Не поняли ответ. Просьбу позвать человека пропускаем: запирать пациента
    // в вопросе о согласии, когда он просит администратора, — жестоко и
    // бессмысленно, человек и возьмёт согласие голосом.
    if (!wantsHuman(text)) {
      return respond(ctx, conversation.id, {
        text: `Нужно ваше согласие на обработку персональных данных.${consentHint(ctx.channel)}`,
        buttons: consentButtons(),
      });
    }
  }

  /**
   * Пункт меню, набранный текстом. В канале без кнопок подсказки уходят
   * строками, и пациент отвечает на них словами — «цены», «адрес».
   */
  const menu = menuActionFromText(text);
  if (menu) return handleCallback(ctx, conversation.id, menu);

  /**
   * Вложение — сразу человеку.
   *
   * Ассистент читает текст: послушать голосовое или разглядеть направление на
   * фотографии он не может. Ответить на непрочитанное — худший исход: пациент
   * получит бодрый ответ не по делу и решит, что его не читают. Проверка идёт
   * до настроек ассистента: увидеть файл человек должен в любом режиме.
   */
  if (attachments.length && needsHuman(attachments)) {
    await escalate(
      ctx.companyId,
      conversation.id,
      "PATIENT_REQUEST",
      `Пациент прислал ${attachments.map((a) => a.label).join(", ")}`,
    ).catch(() => {});
    /**
     * Пациенту не отвечаем ничего. Служебное «передал администратору» — это
     * шум: человек написал живому собеседнику, а получает отчёт о внутренней
     * маршрутизации. Уведомление ушло сотруднику, диалог перешёл под его
     * контроль — дальше говорит он.
     */
    return null;
  }

  return replyToQuestion(ctx, conversation, text);
}

/**
 * Ответ на вопрос пациента.
 *
 * Вынесено из обработки сообщения, потому что вызывается из двух мест: обычной
 * репликой и сразу после согласия на обработку данных. Во втором случае вопрос
 * уже задан — пациент написал его первым сообщением, и переспрашивать «чем могу
 * помочь» значит заставлять человека повторяться.
 */
async function replyToQuestion(
  ctx: AgentContext,
  conversation: { id: string; consentGrantedAt: Date | null },
  text: string,
): Promise<AgentReply | null> {
  const settings = await assistantMode(ctx.companyId);

  // Режим «выключен»: агент молчит полностью, диалог ведёт человек.
  if (settings.mode === "off") {
    await escalate(ctx.companyId, conversation.id, "PATIENT_REQUEST", "Ассистент выключен в настройках").catch(() => {});
    return null;
  }

  // Стоп-слова из настроек: клиника сама решает, о чём агент не говорит.
  if (hitsStopWord(text, settings.stopWords)) {
    await escalate(ctx.companyId, conversation.id, "KEYWORD", "Стоп-слово из настроек").catch(() => {});
    return respond(ctx, conversation.id, { text: "Передал(а) администратору — он ответит здесь же." });
  }

  // Режим «только черновики»: агент сам не отвечает, а зовёт человека.
  // Автономная работа включается в настройках осознанно (§6.4).
  if (settings.mode === "drafts") {
    await escalate(ctx.companyId, conversation.id, "AGENT_REQUEST", "Ассистент в режиме черновиков").catch(() => {});
    return respond(ctx, conversation.id, {
      text: "Передал(а) ваш вопрос администратору — он ответит здесь же.",
    });
  }

  if (personalTopic(text) || wantsHuman(text)) {
    await escalate(ctx.companyId, conversation.id, "PATIENT_REQUEST", "Личный вопрос или жалоба").catch(() => {});
    return respond(ctx, conversation.id, { text: "Передал(а) администратору — он ответит здесь же." });
  }

  /**
   * Пациент прислал данные для записи.
   *
   * Проверяем это раньше медицинских правил намеренно. Анкета содержит жалобу
   * — «боли в пояснице, онемение тела», — и по словам это медицинский текст:
   * агент ответил бы «уточните у специалиста» на присланные для записи данные.
   * Человек выполнил просьбу, а его отправили по кругу.
   *
   * Отвечаем коротко и зовём администратора: дальше нужно поставить время, а
   * это его работа. Сами данные уже в переписке, повторять их незачем.
   */
  const intakeSent = looksLikeIntake(text);
  if (intakeSent) {
    /**
     * Имя из анкеты запоминаем сразу.
     *
     * Пациент представился полным именем, а через две реплики услышал «вы его
     * не называли»: имя было в переписке, но в промпт уходят последние
     * сообщения, и всё, что дальше, для агента не существует. В карточке оно
     * нужно и администратору — диалог перестаёт быть безымянным.
     */
    await rememberName(ctx.companyId, conversation.id, nameFromIntake(text)).catch(() => {});
    await escalate(ctx.companyId, conversation.id, "PATIENT_REQUEST", "Пациент прислал данные для записи").catch(() => {});

    /**
     * Вопрос вместе с данными без ответа не оставляем.
     *
     * «Степан Андрей Павлович, 15 лет, 35 кг, город Махачкала, извиняюсь, а у
     * вас же город тоже Махачкала?» — на такое уходило только «спасибо,
     * записал(а)». Человек спросил и не услышал ответа: сообщение целиком
     * считалось анкетой, а на анкету заготовлена фраза. Если вопрос есть —
     * отвечаем на него обычным путём, а про переданные данные скажем в конце.
     */
    if (!hasQuestion(text)) {
      return respond(ctx, conversation.id, {
        text: "Спасибо, записал(а). Администратор подберёт ближайшее удобное время и напишет здесь же.",
      });
    }
  }

  /**
   * Приветствие. Клиника задаёт его в «Настройки → Ассистент», и до сих пор
   * это поле было чистой декорацией: агент его не читал ни разу, а на «Добрый
   * день» отвечал тем, что придумает модель. Здороваться клиника хочет своими
   * словами — это первое, что видит пациент.
   */
  if (/^\/start\b/.test(text) || isGreeting(text)) {
    /**
     * Отвечаем тем же приветствием, каким поздоровался пациент: на «доброе
     * утро» — «доброе утро», на «салам алейкум» — ответный салам. Одна и та же
     * дежурная фраза на любое приветствие выдаёт автоответчик.
     *
     * Повторно — только приветствие, без вводной: зачитывать её по второму
     * разу в середине разговора значит показать, что предыдущих реплик
     * собеседник не помнит. Но без приветственного слова ответа не бывает —
     * прежде здесь уходило сухое «Слушаю вас».
     */
    const said = await recentTurns(conversation.id);
    /**
     * Повтором считаем не только прошлое приветствие, но и любой предыдущий
     * содержательный ответ. На прогоне пациент спросил про цену, получил
     * ответ, потом поздоровался — и услышал вводную «это клиника такая-то,
     * расскажу про услуги» в середине разговора. Знакомятся один раз.
     */
    const met = alreadyGreeted(said, settings.greeting) || said.some((t) => t.role === "assistant");
    const hello = greetingText({
      incoming: text,
      configured: settings.greeting,
      repeat: met,
    });
    return respond(ctx, conversation.id, { text: hello, buttons: mainMenu() });
  }

  const allKnowledge = await prisma.knowledgeEntry.findMany({
    where: { companyId: ctx.companyId, isActive: true },
    select: { topic: true, question: true, answer: true },
  });

  /**
   * Записи про согласие на обработку данных исключаем, когда согласие уже
   * дано.
   *
   * Согласие ведёт платформа: она спрашивает его первой репликой и хранит
   * факт в базе. В справочнике клиника завела свои формулировки на ту же тему
   * — и агент спрашивал согласие второй раз, уже после «Да». Пациент отвечал
   * «Согласна», получал просьбу согласиться снова и справедливо считал, что с
   * ним разговаривает неисправная программа.
   *
   * Пока согласие не дано, записи остаются: там объяснение, зачем оно нужно, и
   * оно уместно.
   */
  const knowledgeRows = conversation.consentGrantedAt
    ? allKnowledge.filter((r) => !aboutConsent(r.topic) && !aboutConsent(r.question))
    : allKnowledge;

  const said = await recentTurns(conversation.id);

  /**
   * Правило 1: на медицинскую тему отвечаем ТОЛЬКО дословной справкой клиники.
   *
   * Кроме одного случая — когда жалобу только что запросил сам агент. Он
   * спросил «для взрослого или ребёнка и с какой жалобой», пациентка ответила
   * «взрослая женщина, головная боль» — и получила «этот вопрос лучше уточнить
   * у специалиста». Слово «боль» есть, значит медицина; то, что вопрос задал он
   * сам минуту назад, никто не проверял. Человек выполнил просьбу и был послан
   * по кругу, а запись сорвалась.
   *
   * Лечить агент от этого не начинает: советовать по жалобам ему запрещено
   * промптом, а его дело здесь — записать сказанное и довести до администратора.
   */
  if (medical(text) && !inIntakeFlow(said)) {
    const match = matchKnowledge(text, knowledgeRows);
    if (!confidentMatch(match)) {
      await escalate(ctx.companyId, conversation.id, "MEDICAL_QUESTION", "Медицинский вопрос без готового ответа").catch(() => {});
      return respond(ctx, conversation.id, {
        text:
          "Этот вопрос лучше уточнить у специалиста — передал(а) администратору клиники. " +
          "Могу пока рассказать про услуги, цены, адрес и часы работы.",
        buttons: mainMenu(),
      });
    }
    return respond(ctx, conversation.id, {
      text: `${match!.row.answer}\n\nЕсли есть особенности здоровья — уточните у специалиста, я позову администратора.`,
      buttons: mainMenu(),
    });
  }

  /**
   * Организационные вопросы: сначала думаем, дословная справка — подстраховка.
   *
   * Раньше порядок был обратный: нашлась подходящая запись справочника — она и
   * уходила пациенту слово в слово. Из-за этого на «а сколько по времени
   * остеопатия?» человек получал весь блок про остеопатию целиком, включая то,
   * о чём не спрашивал. Формально верно, по-человечески — не ответ.
   *
   * Теперь найденные записи уходят модели как факты, и она отвечает на
   * заданный вопрос. Дословный текст клиники остаётся запасным: если модель
   * недоступна, промолчала или назвала число, которого в справке нет, —
   * отправляем справку, как раньше.
   *
   * Медицинских тем это не касается: они разошлись выше и требуют дословного
   * совпадения (§6.1).
   */
  const exact = matchKnowledge(text, knowledgeRows);

  /**
   * Тема про запись — администратору нужно подключиться в любом случае.
   * Пациенту уходит ответ, человеку — уведомление. Одно другого не заменяет:
   * порядок объясняет справка, время называет человек.
   */
  /**
   * Тема про запись — администратору нужно подключиться в любом случае.
   *
   * Но ответ пациенту на этом больше не заканчивается. Прежде здесь уходил
   * шаблон «запись ведёт администратор», и разговор обрывался ровно в тот
   * момент, когда человек готов записаться: в живой переписке пациентка
   * написала «на приём к остеопату Ирине, взрослый» — и не услышала ни цены,
   * ни вопроса о данных, ничего. Дальше её вёл человек, с нуля.
   *
   * Теперь агент доводит разговор: называет услугу и цену из справки,
   * спрашивает данные для записи и говорит, что время подберёт администратор.
   * Порядок задаёт клиника в «Настройки → Ассистент» (см. lib/agent/intake).
   * Расписанием агент по-прежнему не распоряжается: время, окна и
   * подтверждение — только человек, за этим следит проверка promisesBooking.
   */
  if (scheduleTopic(text)) {
    await escalate(ctx.companyId, conversation.id, "PATIENT_REQUEST", "Вопрос по записи или расписанию").catch(() => {});
  }

  const context = await clinicContext(ctx.companyId, text);
  const answer = await answerLLM(
    text,
    context,
    said,
    intakePrompt(settings.prompt),
    await patientNameFor(conversation.id),
  );

  /**
   * Обещание записать не отправляем никогда: расписанием агент не
   * распоряжается (§6), а пациент, которому пообещали запись, придёт к
   * закрытой двери.
   */
  if (answer && promisesBooking(answer)) {
    await escalate(ctx.companyId, conversation.id, "PATIENT_REQUEST", "Вопрос по записи").catch(() => {});
    return respond(ctx, conversation.id, { text: HANDOVER_REPLY, buttons: mainMenu() });
  }

  /**
   * Числа в ответе сверяем со справкой. Формулировка — дело модели, цена и
   * часы работы — нет: см. lib/agent/grounding.
   */
  const invented = answer ? ungroundedNumbers(answer, context) : [];
  if (invented.length > 0) {
    console.error(`[agent] ответ отклонён: чисел нет в справке — ${invented.join(", ")}`);
  }

  /**
   * Разговор не двигается: агент переспрашивает третий раз подряд (§6).
   *
   * Правило было в требованиях и не жило нигде. На прогоне пациент трижды
   * написал невнятное, и агент трижды бодро уточнил, чем может помочь, — а
   * человека не позвал никто. Живой администратор на третьей реплике уже
   * ответил бы голосом.
   */
  if (stuckInMisunderstanding(said, text)) {
    await escalate(ctx.companyId, conversation.id, "MISUNDERSTOOD", "Агент трижды не понял запрос").catch(() => {});
    return respond(ctx, conversation.id, {
      text: "Давайте я позову администратора — он разберётся быстрее. Он ответит здесь же.",
    });
  }

  if (answer && invented.length === 0 && !alreadySaid(said, answer)) {
    /**
     * Обещал позвать человека — значит человека зовём.
     *
     * На живом диалоге ассистент написал «позову администратора, чтобы она
     * помогла связаться с врачом» — и не позвал: эскалацию создаёт код, а не
     * текст ответа. Администратор о вопросе не узнал, пациентка ждала.
     */
    if (promisesHuman(answer)) {
      await escalate(ctx.companyId, conversation.id, "AGENT_REQUEST", "Ассистент обещал позвать человека").catch(() => {});
    }
    return respond(ctx, conversation.id, {
      text: intakeSent ? `${answer}\n\n${INTAKE_ACCEPTED}` : answer,
      buttons: mainMenu(),
    });
  }

  // Дальше — запасные пути: сказать словами клиники лучше, чем не сказать.
  if (confidentMatch(exact) && !alreadySaid(said, exact!.row.answer)) {
    return respond(ctx, conversation.id, { text: exact!.row.answer, buttons: mainMenu() });
  }

  /**
   * Порог уверенности нужен там, где ответ уходит дословно: подменять один
   * вопрос другим нельзя. Но когда выбора между точным и приблизительным уже
   * нет, приблизительная справка полезнее молчания. Пациент спросил «а что
   * взять с собой» — в справочнике есть «Подготовка к приёму».
   */
  const best = matchKnowledge(text, knowledgeRows);
  if (best && best.hits >= 1 && !alreadySaid(said, best.row.answer)) {
    return respond(ctx, conversation.id, { text: best.row.answer, buttons: mainMenu() });
  }

  // Модель недоступна и подходящей справки нет. Про запись отвечаем по делу,
  // остальное честно передаём человеку.
  if (scheduleTopic(text)) {
    return respond(ctx, conversation.id, {
      text:
        "Время приёма подбирает администратор — передал(а) ему ваш вопрос, он ответит здесь же. " +
        "Чтобы ускорить, пришлите одним сообщением: ФИО, возраст, вес, жалобу и город.",
      buttons: mainMenu(),
    });
  }

  await escalate(ctx.companyId, conversation.id, "MISUNDERSTOOD", "Ассистент не смог ответить").catch(() => {});
  return respond(ctx, conversation.id, {
    text: "Секунду, передаю ваш вопрос администратору — он ответит здесь же.",
    buttons: mainMenu(),
  });
}

/**
 * Как отвечать на вопрос о согласии. В канале с кнопками подсказка не нужна —
 * там они видны; в остальных без неё непонятно, что вообще делать.
 */
function consentHint(channel: AgentChannel): string {
  return supportsButtons(channel) ? "" : "\nОтветьте «Да» или «Нет».";
}

function consentButtons() {
  return [
    { text: "Согласен(на)", data: CONSENT_ACCEPT },
    { text: "Не сейчас", data: CONSENT_DECLINE },
  ];
}

/**
 * Запомнить имя, которым представился пациент.
 *
 * В карточку, если она уже привязана, иначе — в имя контакта на диалоге.
 * Затирать заполненное имя не будем: в карточке его мог поправить
 * администратор, и его правка важнее нашей догадки из переписки.
 */
async function rememberName(companyId: string, conversationId: string, name: string | null): Promise<void> {
  if (!name) return;
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { patientId: true, contactName: true },
  });
  if (!conv) return;

  if (conv.patientId) {
    await prisma.patient.updateMany({
      where: { id: conv.patientId, companyId, OR: [{ name: null }, { name: "" }] },
      data: { name },
    });
    return;
  }
  /**
   * Имя контакта из мессенджера — это «Ася» или «..», как человек подписал свой
   * профиль. Названное для записи ФИО полнее, и в диалоге администратору нужно
   * именно оно. Считаем по числу слов: правку администратора («Ася, мама
   * Умара») двумя словами не перебить.
   */
  const current = conv.contactName?.trim() ?? "";
  const words = (v: string) => v.split(/\s+/).filter(Boolean).length;
  if (!current || words(name) > words(current)) {
    await prisma.conversation.update({ where: { id: conversationId }, data: { contactName: name } });
  }
}

/** Подтверждение, что анкета ушла администратору. */
const INTAKE_ACCEPTED = "Данные передал(а) администратору — он подберёт время и напишет здесь же.";

/** Как зовут собеседника: имя карточки, иначе имя контакта из мессенджера. */
async function patientNameFor(conversationId: string): Promise<string | null> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { contactName: true, patient: { select: { name: true } } },
  });
  return conv?.patient?.name?.trim() || conv?.contactName?.trim() || null;
}

/**
 * Вопрос, который пациент задал до того, как у него спросили согласие.
 *
 * Берём последнее его сообщение, кроме самого ответа про согласие и голого
 * приветствия: «Да» и «Здравствуйте» вопросами не являются, отвечать на них
 * после согласия нечего — на приветствие ответит приветствие.
 */
async function pendingQuestion(conversationId: string): Promise<string | null> {
  const rows = await prisma.message.findMany({
    where: { conversationId, direction: "IN", deletedAt: null, isDraft: false },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { body: true },
  });
  for (const row of rows) {
    const body = row.body.trim();
    if (!body) continue;
    if (consentFromText(body)) continue;
    if (isGreeting(body)) continue;
    // Слишком короткое — не вопрос, а реакция: «ок», «ага», смайлик.
    if (body.length < 4) continue;
    return body;
  }
  return null;
}

/**
 * Запись справочника — про согласие на обработку данных?
 *
 * Проверяем тему и список формулировок, а не ответ: в ответе слово «согласие»
 * встречается и в записях о правилах отмены.
 */
function aboutConsent(text: string): boolean {
  return /соглас|персональн\w* данн/i.test(text);
}

function mainMenu() {
  // Кнопки записи нет намеренно: расписанием распоряжается администратор.
  return [
    { text: "Услуги и цены", data: "prices" },
    { text: "Адрес", data: "address" },
    { text: "Часы работы", data: "hours" },
    { text: "Позвать администратора", data: "human" },
  ];
}

async function handleCallback(ctx: AgentContext, conversationId: string, data: string): Promise<AgentReply> {
  if (data === CONSENT_ACCEPT) {
    await grantConsent(ctx.companyId, conversationId);
    // Первая фраза после согласия — по сути и есть приветствие клиники: до
    // этого пациент видел только юридический текст. Берём её из настроек,
    // чтобы знакомство шло словами клиники, а не нашей заглушкой.
    const { greeting } = await assistantMode(ctx.companyId);
    const hello = greeting.trim() || "Спасибо!";

    /**
     * Вопрос, заданный до согласия.
     *
     * Пациент пишет «когда есть окошко к Ирине?», получает юридический текст,
     * отвечает «Да» — и слышит «чем я могу вам помочь?». То есть его просят
     * повторить то, что он уже написал. В живых переписках это видно раз за
     * разом: человек дублирует вопрос, и только тогда разговор начинается.
     *
     * Поэтому: здороваемся и сразу отвечаем на заданный вопрос. Встречное
     * «чем могу помочь» из приветствия убираем — отвечать есть на что.
     */
    const pending = await pendingQuestion(conversationId);
    if (pending) {
      const conv = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { id: true, consentGrantedAt: true },
      });
      const answer = conv ? await replyToQuestion(ctx, conv, pending) : null;
      if (answer) {
        return { ...answer, text: `${withoutOffer(hello)}\n\n${answer.text}` };
      }
    }

    return respond(ctx, conversationId, {
      text: greeting.trim() ? `Спасибо!\n\n${hello}` : "Спасибо. Чем можем помочь?",
      buttons: mainMenu(),
    });
  }
  if (data === CONSENT_DECLINE) {
    // Без согласия обрабатывать обращение нельзя — зовём человека, он решит,
    // как быть: по телефону согласие тоже можно взять.
    await escalate(ctx.companyId, conversationId, "PATIENT_REQUEST", "Пациент не дал согласие на обработку ПДн").catch(() => {});
    return respond(ctx, conversationId, {
      text:
        "Хорошо. Без согласия на обработку персональных данных мы не сможем вести переписку — " +
        "передал(а) администратору, он свяжется с вами.",
    });
  }
  if (data === "prices") {
    const services = await getServices(ctx.companyId);
    const lines = services.map((s) => `• ${s.title} — ${s.price} ₽, ${s.durationMin} мин`);
    return respond(ctx, conversationId, {
      text: `Услуги и цены:\n${lines.join("\n")}`,
      buttons: mainMenu(),
    });
  }

  if (data === "address") {
    // Адрес — из справочника клиники. Нет записи — честно зовём человека,
    // а не пересказываем весь справочник.
    const rows = await prisma.knowledgeEntry.findMany({
      where: { companyId: ctx.companyId, isActive: true },
      select: { topic: true, question: true, answer: true },
    });
    const m = matchKnowledge("адрес как добраться где находитесь", rows);
    if (m && m.topicCoverage > 0) {
      return respond(ctx, conversationId, { text: m.row.answer, buttons: mainMenu() });
    }
    await escalate(ctx.companyId, conversationId, "MISUNDERSTOOD", "Адрес не заполнен в справочнике").catch(() => {});
    return respond(ctx, conversationId, {
      text: "Адрес уточнит администратор — передал(а) ему вопрос.",
      buttons: mainMenu(),
    });
  }

  if (data === "hours") {
    const schedule = await prisma.clinicSchedule.findMany({
      where: { companyId: ctx.companyId },
      orderBy: { weekday: "asc" },
      select: { weekday: true, startMinute: true, endMinute: true },
    });
    const days = ["", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
    const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const lines = schedule.map((d) => `${days[d.weekday]}: ${hhmm(d.startMinute)}–${hhmm(d.endMinute)}`);
    const closed = [1, 2, 3, 4, 5, 6, 7].filter((w) => !schedule.some((d) => d.weekday === w));
    if (closed.length) lines.push(`Выходной: ${closed.map((w) => days[w]).join(", ")}`);
    return respond(ctx, conversationId, { text: `Часы работы:\n${lines.join("\n")}`, buttons: mainMenu() });
  }

  if (data === "human" || data === "book") {
    await escalate(ctx.companyId, conversationId, "PATIENT_REQUEST", "Пациент просит человека").catch(() => {});
    return { text: "Передал(а) администратору — он ответит здесь же." };
  }

  return { text: "Не понял(а) выбор. Попробуйте ещё раз.", buttons: mainMenu() };
}

/**
 * Номер телефона от пациента. Записи бот не создаёт, поэтому номер просто
 * привязываем к диалогу и передаём администратору — ему звонить и записывать.
 */
/**
 * Найти или завести карточку по номеру и привязать к диалогу.
 *
 * Общая часть для двух случаев: пациент прислал контакт в Telegram и номер
 * известен из адреса чата WhatsApp. Разница только в том, что в первом случае
 * мы отвечаем пациенту, а во втором молчим.
 */
async function linkByPhone(
  ctx: AgentContext,
  conversationId: string,
  rawPhone: string,
): Promise<string | null> {
  const phone = normalizePhone(rawPhone);
  if (!phone) return null;

  const existing = await prisma.patientPhone.findFirst({
    where: { companyId: ctx.companyId, phone },
    select: { patientId: true },
  });
  let patientId = existing?.patientId ?? null;

  if (!patientId) {
    const source = await prisma.source.findFirst({
      where: { companyId: ctx.companyId, code: ctx.channel.toLowerCase() },
      select: { id: true },
    });
    const created = await prisma.patient.create({
      data: {
        companyId: ctx.companyId,
        name: ctx.displayName ?? null,
        firstSeenAt: new Date(),
        sourceId: source?.id ?? null,
      },
      select: { id: true },
    });
    await prisma.patientPhone.create({
      data: { companyId: ctx.companyId, patientId: created.id, phone, isPrimary: true },
    });
    patientId = created.id;
  }

  await prisma.conversation.update({ where: { id: conversationId }, data: { patientId } });
  // Согласие могли дать до появления карточки — переносим его в карточку.
  await materializeConsent(ctx.companyId, patientId, conversationId).catch(() => {});
  return patientId;
}

async function attachPhone(ctx: AgentContext, conversationId: string, rawPhone: string): Promise<AgentReply> {
  const patientId = await linkByPhone(ctx, conversationId, rawPhone);
  if (!patientId) return { text: "Не удалось разобрать номер. Отправьте его ещё раз.", askPhone: true };

  await escalate(ctx.companyId, conversationId, "PATIENT_REQUEST", "Пациент оставил номер для записи").catch(() => {});
  return { text: "Спасибо, передал(а) номер администратору — он свяжется и подберёт время." };
}
