import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { notifyStaff, inboxRecipients } from "@/lib/server/notify";
import { CLINIC_NAME } from "@/lib/brand";
import { getServices } from "./booking";
import { KNOWLEDGE_MIN_SCORE, matchKnowledge } from "./knowledge";
import { answerLLM } from "./llm";

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

/**
 * Расписание — зона администратора. Сюда же отмены и переносы: заказчик хочет
 * держать эти решения за человеком.
 */
const SCHEDULE_PATTERNS = [
  /запиш|записать|записаться|запись\b/i, /свободн/i, /окошк|окно\b|окна\b/i,
  /перенест|перенос/i, /отменит|отмена записи|отменить запись/i,
  /когда можно прийти|на какое время/i,
];

/**
 * Личное: жалобы и вопросы про конкретного пациента. Всегда человеку — здесь
 * и врачебная тайна, и репутационный риск.
 */
const PERSONAL_PATTERNS = [
  /жалоб/i, /претенз/i, /вернуть деньги|возврат/i, /юрист/i, /врач ошибс/i,
  /мой визит|моя запись|мои записи/i, /мой анализ|мои анализ/i,
];

/**
 * Медицинские темы. Отвечаем на них ТОЛЬКО дословной справкой клиники; если
 * подходящей записи нет — человеку.
 */
const MEDICAL_PATTERNS = [
  /симптом/i, /диагноз/i, /болит|боль\b|болел/i, /лечени[ея]/i, /назнач/i,
  /дозировк|доза\b/i, /противопоказан/i, /анализ[ыа]?\s+показал/i, /побочн/i,
  /таблетк|препарат|лекарств/i, /беременн/i, /температур/i, /давлени[ея]/i,
  /подготов|готовит/i, /можно ли мне\b/i, /опасно ли/i, /вредно ли/i,
];

const HUMAN_PATTERNS = [
  /админист/i, /оператор/i, /человек[а-я]*\b/i, /žив|живой/i, /менеджер/i, /жалоб/i,
  /вернуть деньги|возврат/i, /юрист/i, /врач ошибс/i,
];

export interface AgentReply {
  text: string;
  buttons?: { text: string; data: string }[];
  /** Запросить номер телефона кнопкой Telegram. */
  askPhone?: boolean;
}

export interface AgentContext {
  companyId: string;
  channel: "TELEGRAM";
  externalUserId: string;
  displayName?: string | null;
}

function medical(text: string): boolean {
  return MEDICAL_PATTERNS.some((re) => re.test(text));
}
function scheduleTopic(text: string): boolean {
  return SCHEDULE_PATTERNS.some((re) => re.test(text));
}
function personalTopic(text: string): boolean {
  return PERSONAL_PATTERNS.some((re) => re.test(text));
}
function wantsHuman(text: string): boolean {
  return HUMAN_PATTERNS.some((re) => re.test(text));
}

// ─────────────────────────────────────────────── диалог

async function loadConversation(ctx: AgentContext) {
  const existing = await prisma.conversation.findFirst({
    where: { companyId: ctx.companyId, channel: ctx.channel, externalUserId: ctx.externalUserId },
  });
  if (existing) return existing;

  const source = await prisma.source.findFirst({
    where: { companyId: ctx.companyId, code: "telegram" },
    select: { id: true },
  });
  return prisma.conversation.create({
    data: {
      companyId: ctx.companyId,
      channel: ctx.channel,
      externalUserId: ctx.externalUserId,
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
  channel: "TELEGRAM";
  direction: "IN" | "OUT";
  authorType: "PATIENT" | "BOT" | "STAFF";
  body: string;
  externalId?: string | null;
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

async function escalate(companyId: string, conversationId: string, reason: "MEDICAL_QUESTION" | "PATIENT_REQUEST" | "KEYWORD" | "MISUNDERSTOOD", note: string) {
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { status: "ESCALATED" },
  });
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
    recipientIds: await inboxRecipients(companyId),
    kind: "ESCALATION",
    title: "Диалог передан человеку",
    body: note,
    url: "/inbox",
    entityId: conversationId,
  });
}

// ─────────────────────────────────────────────── справка из базы

async function clinicContext(companyId: string): Promise<string> {
  const [services, knowledge, schedule] = await Promise.all([
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
  ]);

  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const days = ["", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

  const lines = [`# Клиника «${CLINIC_NAME}»`, "", "## Услуги и цены"];
  for (const s of services) lines.push(`- ${s.title}: ${s.price} ₽, ${s.durationMin} мин`);
  lines.push("", "## Часы работы");
  for (const d of schedule) lines.push(`- ${days[d.weekday]}: ${hhmm(d.startMinute)}–${hhmm(d.endMinute)}`);
  if (knowledge.length) {
    lines.push("", "## Справка");
    for (const k of knowledge) lines.push(`- ${k.topic}: ${k.answer}`);
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────── обработка

export async function handlePatientMessage(
  ctx: AgentContext,
  input: { text?: string; phone?: string; callbackData?: string; externalId?: string },
): Promise<AgentReply | null> {
  const conversation = await loadConversation(ctx);

  // Правило 4: после ручного ответа сотрудника агент молчит.
  const paused =
    conversation.status === "HUMAN_TAKEOVER" &&
    conversation.botPausedUntil !== null &&
    conversation.botPausedUntil > new Date();
  if (paused) {
    if (input.text) {
      await saveMessage({
        companyId: ctx.companyId,
        conversationId: conversation.id,
        channel: "TELEGRAM",
        direction: "IN",
        authorType: "PATIENT",
        body: input.text,
        externalId: input.externalId,
      });
      await notifyStaff({
        companyId: ctx.companyId,
        recipientIds: await inboxRecipients(ctx.companyId),
        kind: "PATIENT_MESSAGE",
        title: "Новое сообщение в Telegram",
        body: "Диалог ведёт сотрудник — агент не отвечает",
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

  const text = (input.text ?? "").trim();
  if (!text) return null;

  await saveMessage({
    companyId: ctx.companyId,
    conversationId: conversation.id,
    channel: "TELEGRAM",
    direction: "IN",
    authorType: "PATIENT",
    body: text,
    externalId: input.externalId,
  });

  // Расписание — зона администратора (решение заказчика).
  if (scheduleTopic(text)) {
    await escalate(ctx.companyId, conversation.id, "PATIENT_REQUEST", "Вопрос по записи или расписанию").catch(() => {});
    const reply =
      "Запись, свободное время и переносы ведёт администратор — передал(а) ему ваш вопрос, " +
      "он ответит здесь же. Пока могу рассказать про услуги, цены, адрес и часы работы.";
    await saveMessage({
      companyId: ctx.companyId,
      conversationId: conversation.id,
      channel: "TELEGRAM",
      direction: "OUT",
      authorType: "BOT",
      body: reply,
    });
    return { text: reply, buttons: mainMenu() };
  }

  if (personalTopic(text) || wantsHuman(text)) {
    await escalate(ctx.companyId, conversation.id, "PATIENT_REQUEST", "Личный вопрос или жалоба").catch(() => {});
    return { text: "Передал(а) администратору — он ответит здесь же." };
  }

  if (/^\/start\b/.test(text)) {
    return {
      text: `Здравствуйте! Это клиника «${CLINIC_NAME}». Расскажу про услуги, цены, адрес, часы работы, подготовку к процедурам и условия отмены. Запись и переносы ведёт администратор — передам ему.`,
      buttons: mainMenu(),
    };
  }

  const knowledgeRows = await prisma.knowledgeEntry.findMany({
    where: { companyId: ctx.companyId, isActive: true },
    select: { topic: true, question: true, answer: true },
  });

  // Правило 1: на медицинскую тему отвечаем ТОЛЬКО дословной справкой клиники.
  if (medical(text)) {
    const match = matchKnowledge(text, knowledgeRows);
    if (!match || match.score < KNOWLEDGE_MIN_SCORE) {
      await escalate(ctx.companyId, conversation.id, "MEDICAL_QUESTION", "Медицинский вопрос без готового ответа").catch(() => {});
      return {
        text:
          "Этот вопрос лучше уточнить у специалиста — передал(а) администратору клиники. " +
          "Могу пока рассказать про услуги, цены, адрес и часы работы.",
        buttons: mainMenu(),
      };
    }
    const reply = `${match.row.answer}\n\nЕсли есть особенности здоровья — уточните у специалиста, я позову администратора.`;
    await saveMessage({
      companyId: ctx.companyId,
      conversationId: conversation.id,
      channel: "TELEGRAM",
      direction: "OUT",
      authorType: "BOT",
      body: reply,
    });
    return { text: reply, buttons: mainMenu() };
  }

  // Прочие организационные вопросы: сначала точная справка, иначе модель,
  // ограниченная справочником и данными из базы.
  const exact = matchKnowledge(text, knowledgeRows);
  if (exact && exact.score >= KNOWLEDGE_MIN_SCORE) {
    await saveMessage({
      companyId: ctx.companyId,
      conversationId: conversation.id,
      channel: "TELEGRAM",
      direction: "OUT",
      authorType: "BOT",
      body: exact.row.answer,
    });
    return { text: exact.row.answer, buttons: mainMenu() };
  }

  const context = await clinicContext(ctx.companyId);
  const answer = await answerLLM(text, context);
  if (!answer) {
    await escalate(ctx.companyId, conversation.id, "MISUNDERSTOOD", "Нет ответа в справке клиники").catch(() => {});
    return {
      text: "Не нашёл(ла) ответ в справке клиники — передал(а) администратору.",
      buttons: mainMenu(),
    };
  }

  await saveMessage({
    companyId: ctx.companyId,
    conversationId: conversation.id,
    channel: "TELEGRAM",
    direction: "OUT",
    authorType: "BOT",
    body: answer,
  });
  return { text: answer, buttons: mainMenu() };
}

function mainMenu() {
  // Кнопки записи нет намеренно: расписанием распоряжается администратор.
  return [
    { text: "Услуги и цены", data: "prices" },
    { text: "Адрес и часы", data: "info" },
    { text: "Позвать администратора", data: "human" },
  ];
}

async function handleCallback(ctx: AgentContext, conversationId: string, data: string): Promise<AgentReply> {
  if (data === "prices") {
    const services = await getServices(ctx.companyId);
    const lines = services.map((s) => `• ${s.title} — ${s.price} ₽, ${s.durationMin} мин`);
    return { text: `Услуги и цены:\n${lines.join("\n")}`, buttons: mainMenu() };
  }

  if (data === "info") {
    const text = await clinicContext(ctx.companyId);
    return { text, buttons: mainMenu() };
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
async function attachPhone(ctx: AgentContext, conversationId: string, rawPhone: string): Promise<AgentReply> {
  const phone = normalizePhone(rawPhone);
  if (!phone) return { text: "Не удалось разобрать номер. Отправьте его ещё раз.", askPhone: true };

  const existing = await prisma.patientPhone.findFirst({
    where: { companyId: ctx.companyId, phone },
    select: { patientId: true },
  });
  let patientId = existing?.patientId ?? null;
  if (!patientId) {
    const source = await prisma.source.findFirst({
      where: { companyId: ctx.companyId, code: "telegram" },
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
  await escalate(ctx.companyId, conversationId, "PATIENT_REQUEST", "Пациент оставил номер для записи").catch(() => {});
  return { text: "Спасибо, передал(а) номер администратору — он свяжется и подберёт время." };
}
