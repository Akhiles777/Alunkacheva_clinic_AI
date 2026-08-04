import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { notifyStaff, inboxRecipients } from "@/lib/server/notify";
import { CLINIC_NAME } from "@/lib/brand";
import { createBooking, getFreeSlots, getServices, slotLabel } from "./booking";
import { answerLLM } from "./llm";

/**
 * Агент пациентского канала: отвечает на типовые вопросы и записывает на приём.
 *
 * Жёсткие правила (§6), нарушать нельзя:
 *   1. Никакой медицины. Симптомы, диагнозы, назначения, противопоказания —
 *      немедленная эскалация, без попытки ответить.
 *   2. Ничего не выдумывать: цены, услуги, часы — только из базы.
 *   3. Слот перепроверяется перед записью (это делает createBooking).
 *   4. После перехвата человеком агент молчит, пока пауза не истечёт. Бот,
 *      перебивающий администратора, — худший баг в системе.
 *
 * Запись сделана кнопками, а не разбором свободного текста: пациент выбирает
 * услугу и время из реальных вариантов, поэтому «записался не туда» не бывает.
 */

/**
 * Пауза агента после того, как сотрудник ответил вручную (§6.4). Время, а не
 * флаг: пауза должна истекать сама, иначе диалог навсегда останется без бота.
 */
export const HUMAN_TAKEOVER_HOURS = 12;

export function humanTakeoverUntil(from: Date = new Date()): Date {
  return new Date(from.getTime() + HUMAN_TAKEOVER_HOURS * 3600 * 1000);
}

const MEDICAL_PATTERNS = [
  /симптом/i, /диагноз/i, /болит|боль\b|болел/i, /лечени[ея]/i, /назнач/i,
  /дозировк|доза\b/i, /противопоказан/i, /анализ[ыа]?\s+показал/i, /побочн/i,
  /таблетк|препарат|лекарств/i, /беременн/i, /температур/i, /давлени[ея]/i,
  /можно ли мне\b/i, /опасно ли/i, /вредно ли/i,
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

async function escalate(companyId: string, conversationId: string, reason: "MEDICAL_QUESTION" | "PATIENT_REQUEST" | "KEYWORD", note: string) {
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

// ─────────────────────────────────────────────── состояние записи
//
// Черновик записи держим в самом диалоге (Conversation.botDraft не существует,
// поэтому — в отдельной служебной записи Message с authorType BOT и префиксом).
// Так состояние переживает перезапуск процесса и не требует новой таблицы.

const DRAFT_PREFIX = "__draft__";

interface Draft {
  serviceId?: string;
  startAt?: string;
  staffId?: string;
  /** Показанные пациенту окна: в кнопку влезает только индекс. */
  slots?: { startAt: string; staffId: string }[];
}

async function readDraft(conversationId: string): Promise<Draft> {
  const row = await prisma.message.findFirst({
    where: { conversationId, body: { startsWith: DRAFT_PREFIX } },
    orderBy: { createdAt: "desc" },
    select: { body: true },
  });
  if (!row) return {};
  try {
    return JSON.parse(row.body.slice(DRAFT_PREFIX.length));
  } catch {
    return {};
  }
}

async function writeDraft(companyId: string, conversationId: string, draft: object) {
  await prisma.message.create({
    data: {
      companyId,
      conversationId,
      channel: "TELEGRAM",
      direction: "OUT",
      authorType: "BOT",
      body: `${DRAFT_PREFIX}${JSON.stringify(draft)}`,
    },
  });
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
    return finishBooking(ctx, conversation.id, input.phone);
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

  // Правило 1: медицина — сразу человеку, без попытки ответить.
  if (medical(text)) {
    await escalate(ctx.companyId, conversation.id, "MEDICAL_QUESTION", "Медицинский вопрос от пациента").catch(() => {});
    return {
      text:
        "Этот вопрос я не решаю — он медицинский. Передал(а) администратору клиники, " +
        "с вами свяжутся. Могу пока записать на приём или рассказать про услуги и цены.",
      buttons: mainMenu(),
    };
  }

  if (wantsHuman(text)) {
    await escalate(ctx.companyId, conversation.id, "PATIENT_REQUEST", "Пациент просит человека").catch(() => {});
    return { text: "Передал(а) администратору — он ответит здесь же." };
  }

  if (/^\/start\b/.test(text)) {
    return {
      text: `Здравствуйте! Это клиника «${CLINIC_NAME}». Помогу записаться на приём и отвечу на вопросы об услугах, ценах и времени работы.`,
      buttons: mainMenu(),
    };
  }

  if (/запис|записать|прием|приём|свободн|окно|время/i.test(text)) {
    return serviceMenu(ctx.companyId);
  }

  // Правило 2: отвечаем строго по справке из базы.
  const context = await clinicContext(ctx.companyId);
  const answer = await answerLLM(text, context);
  const reply =
    answer ??
    "Не нашёл(ла) ответ в справке клиники. Могу записать на приём или позвать администратора.";

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

function mainMenu() {
  return [
    { text: "Записаться", data: "book" },
    { text: "Услуги и цены", data: "prices" },
    { text: "Позвать администратора", data: "human" },
  ];
}

async function serviceMenu(companyId: string): Promise<AgentReply> {
  const services = await getServices(companyId);
  if (services.length === 0) return { text: "Список услуг пока не заполнен.", buttons: mainMenu() };
  return {
    text: "Выберите услугу:",
    buttons: services.slice(0, 10).map((s) => ({ text: `${s.title} · ${s.price} ₽`, data: `svc:${s.id}` })),
  };
}

async function handleCallback(ctx: AgentContext, conversationId: string, data: string): Promise<AgentReply> {
  if (data === "book") return serviceMenu(ctx.companyId);

  if (data === "prices") {
    const services = await getServices(ctx.companyId);
    const lines = services.map((s) => `• ${s.title} — ${s.price} ₽, ${s.durationMin} мин`);
    return { text: `Услуги и цены:\n${lines.join("\n")}`, buttons: mainMenu() };
  }

  if (data === "human") {
    await escalate(ctx.companyId, conversationId, "PATIENT_REQUEST", "Пациент просит человека").catch(() => {});
    return { text: "Передал(а) администратору — он ответит здесь же." };
  }

  if (data.startsWith("svc:")) {
    const serviceId = data.slice(4);
    const from = new Date();
    const to = new Date(from.getTime() + 14 * 24 * 3600 * 1000);
    const slots = await getFreeSlots({ companyId: ctx.companyId, serviceId, dateFrom: from, dateTo: to, limit: 8 });
    if (slots.length === 0) {
      await escalate(ctx.companyId, conversationId, "KEYWORD", "Нет свободных окон на две недели").catch(() => {});
      return { text: "На ближайшие две недели свободных окон нет. Передал(а) администратору — подберёт время." };
    }
    // В callback_data Telegram помещается 64 байта — идентификаторы услуги,
    // специалиста и время туда не влезают. Кладём варианты в черновик, а в
    // кнопку — только порядковый номер.
    await writeDraft(ctx.companyId, conversationId, {
      serviceId,
      slots: slots.map((s) => ({ startAt: s.startAt, staffId: s.staffId })),
    });
    return {
      text: "Свободное время:",
      buttons: slots.map((s, i) => ({ text: s.label, data: `slot:${i}` })),
    };
  }

  if (data.startsWith("slot:")) {
    const index = Number(data.slice(5));
    const draft = await readDraft(conversationId);
    const chosen = draft.slots?.[index];
    if (!chosen || !draft.serviceId) {
      return { text: "Список времени устарел. Выберите услугу заново.", buttons: mainMenu() };
    }
    await writeDraft(ctx.companyId, conversationId, {
      serviceId: draft.serviceId,
      startAt: chosen.startAt,
      staffId: chosen.staffId,
    });
    return {
      text: "Чтобы закрепить запись, отправьте номер телефона — по нему администратор найдёт вас в базе.",
      askPhone: true,
    };
  }

  return { text: "Не понял(а) выбор. Попробуйте ещё раз.", buttons: mainMenu() };
}

async function finishBooking(ctx: AgentContext, conversationId: string, rawPhone: string): Promise<AgentReply> {
  const phone = normalizePhone(rawPhone);
  if (!phone) return { text: "Не удалось разобрать номер. Отправьте его ещё раз.", askPhone: true };

  const draft = await readDraft(conversationId);
  if (!draft.serviceId || !draft.startAt || !draft.staffId) {
    return { text: "Давайте начнём заново — выберите услугу.", buttons: mainMenu() };
  }

  // Пациент по номеру: телефон — единственный надёжный ключ (§4).
  const existingPhone = await prisma.patientPhone.findFirst({
    where: { companyId: ctx.companyId, phone },
    select: { patientId: true },
  });
  let patientId = existingPhone?.patientId ?? null;
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

  const result = await createBooking({
    companyId: ctx.companyId,
    patientId,
    serviceId: draft.serviceId,
    staffId: draft.staffId,
    startAt: new Date(draft.startAt),
    conversationId,
    note: "Запись через Telegram-бота",
  });

  if (!result.ok) {
    // Слот заняли, пока пациент отправлял номер — предлагаем выбрать заново.
    if (result.reason === "slot_taken") {
      return { text: `${result.message}`, buttons: [{ text: "Выбрать другое время", data: `svc:${draft.serviceId}` }] };
    }
    await escalate(ctx.companyId, conversationId, "KEYWORD", `Не удалось записать: ${result.message}`).catch(() => {});
    return { text: `${result.message} Передал(а) администратору.` };
  }

  await notifyStaff({
    companyId: ctx.companyId,
    recipientIds: await inboxRecipients(ctx.companyId),
    kind: "BOOKING",
    title: "Новая запись из Telegram",
    body: `${result.label} · ${result.staffName}`,
    url: "/schedule",
    entityId: result.appointmentId,
  });

  const text = `Записал(а): ${result.label}, ${result.staffName}, ${result.roomName}. Если планы изменятся — напишите здесь.`;
  await saveMessage({
    companyId: ctx.companyId,
    conversationId,
    channel: "TELEGRAM",
    direction: "OUT",
    authorType: "BOT",
    body: text,
  });
  return { text, buttons: mainMenu() };
}

export { slotLabel };
