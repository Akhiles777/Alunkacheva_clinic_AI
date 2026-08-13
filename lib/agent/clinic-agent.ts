import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { notifyStaff, inboxRecipients } from "@/lib/server/notify";
import { CLINIC_NAME } from "@/lib/brand";
import { getServices } from "./booking";
import { confidentMatch, matchKnowledge } from "./knowledge";
import { answerLLM, type Turn } from "./llm";
import { HANDOVER_REPLY, promisesBooking } from "./booking-promise";
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
export type AgentChannel = "TELEGRAM" | "WHATSAPP";

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
    if (ctx.displayName && existing.contactName !== ctx.displayName) {
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
    recipientIds: await inboxRecipients(companyId),
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
}

const DEFAULT_MODE: AssistantMode = {
  mode: "on",
  greeting: "",
  stopWords: [],
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
const KNOWLEDGE_IN_PROMPT = 8;

/**
 * Предел справки в промпте по объёму, а не только по числу записей.
 *
 * Ограничения по количеству мало: записи бывают по полторы тысячи знаков.
 * Восемь таких — уже двенадцать килобайт, и модель отвечает медленнее, чем
 * ждёт вебхук. На бюджете в восемь тысяч знаков ответ укладывается в срок.
 */
const KNOWLEDGE_CHARS_BUDGET = 8000;

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

  // Без разметки: этот текст и уходит в модель, и показывается пациенту.
  // Символы # и * в мессенджере выглядят как мусор.
  const lines = [`Клиника «${CLINIC_NAME}».`, "", "Услуги и цены:"];
  for (const s of services) lines.push(`• ${s.title} — ${s.price} ₽, ${s.durationMin} мин`);
  lines.push("", "Часы работы:");
  for (const d of schedule) lines.push(`${days[d.weekday]}: ${hhmm(d.startMinute)}–${hhmm(d.endMinute)}`);
  const closed = [1, 2, 3, 4, 5, 6, 7].filter((w) => !schedule.some((d) => d.weekday === w));
  if (closed.length) lines.push(`Выходной: ${closed.map((w) => days[w]).join(", ")}`);
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

async function recentTurns(conversationId: string): Promise<Turn[]> {
  const rows = await prisma.message.findMany({
    where: { conversationId, deletedAt: null, isDraft: false },
    orderBy: { createdAt: "desc" },
    take: 11,
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
  await saveMessage({
    companyId: ctx.companyId,
    conversationId,
    channel: ctx.channel,
    direction: "OUT",
    authorType: "BOT",
    body: reply.text,
  });
  return reply;
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
        channel: ctx.channel,
        direction: "IN",
        authorType: "PATIENT",
        body: input.text,
        externalId: input.externalId,
      });
      await notifyStaff({
        companyId: ctx.companyId,
        recipientIds: await inboxRecipients(ctx.companyId),
        kind: "PATIENT_MESSAGE",
        title: "Новое сообщение от пациента",
        // Без служебных пояснений про агента: сотруднику важно, что пациент
        // написал и ждёт ответа, а не в каком режиме сейчас бот.
        body: "Пациент написал в Telegram",
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
    channel: ctx.channel,
    direction: "IN",
    authorType: "PATIENT",
    body: text,
    externalId: input.externalId,
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
   * Приветствие. Клиника задаёт его в «Настройки → Ассистент», и до сих пор
   * это поле было чистой декорацией: агент его не читал ни разу, а на «Добрый
   * день» отвечал тем, что придумает модель. Здороваться клиника хочет своими
   * словами — это первое, что видит пациент.
   */
  if (/^\/start\b/.test(text) || isGreeting(text)) {
    const hello =
      settings.greeting.trim() ||
      `Здравствуйте! Это клиника «${CLINIC_NAME}». Расскажу про услуги, цены, адрес, часы работы, ` +
        "подготовку к процедурам и условия отмены. Запись и переносы ведёт администратор — передам ему.";
    return respond(ctx, conversation.id, { text: hello, buttons: mainMenu() });
  }

  const knowledgeRows = await prisma.knowledgeEntry.findMany({
    where: { companyId: ctx.companyId, isActive: true },
    select: { topic: true, question: true, answer: true },
  });

  // Правило 1: на медицинскую тему отвечаем ТОЛЬКО дословной справкой клиники.
  if (medical(text)) {
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
   * Прочие организационные вопросы: сначала точная справка.
   *
   * Справочник проверяется РАНЬШЕ ветки про расписание намеренно. Прежде было
   * наоборот, и на «Как записаться» пациент получал казённое «запись ведёт
   * администратор» — хотя клиника завела на этот самый вопрос свой ответ и
   * утвердила его. Наш текст перебивал текст клиники, а §6 требует ровно
   * обратного: отвечаем тем, что клиника написала сама.
   */
  const exact = matchKnowledge(text, knowledgeRows);
  if (confidentMatch(exact)) {
    /**
     * Ответ есть, но тема всё равно про запись — значит администратору нужно
     * подключиться. Пациенту уходит текст клиники, человеку — уведомление.
     * Одно другого не заменяет: справка объясняет порядок, время называет
     * человек.
     */
    if (scheduleTopic(text)) {
      await escalate(ctx.companyId, conversation.id, "PATIENT_REQUEST", "Вопрос по записи").catch(() => {});
    }
    return respond(ctx, conversation.id, { text: exact!.row.answer, buttons: mainMenu() });
  }

  // Расписание — зона администратора (решение заказчика). Сюда попадаем
  // только когда своего ответа у клиники нет.
  if (scheduleTopic(text)) {
    await escalate(ctx.companyId, conversation.id, "PATIENT_REQUEST", "Вопрос по записи или расписанию").catch(() => {});
    return respond(ctx, conversation.id, {
      text:
        "Запись, свободное время и переносы ведёт администратор — передал(а) ему ваш вопрос, " +
        "он ответит здесь же. Пока могу рассказать про услуги, цены, адрес и часы работы.",
      buttons: mainMenu(),
    });
  }

  const context = await clinicContext(ctx.companyId, text);
  const answer = await answerLLM(text, context, await recentTurns(conversation.id));
  if (!answer) {
    /**
     * Модель недоступна или молчит. Раньше сюда отдавалась вся справка
     * клиники — и пациент получал простыню на двадцать шесть тысяч знаков:
     * весь прайс, часы работы и каждую запись справочника разом, в ответ на
     * «Добрый день». Это выглядит как поломка и отпугивает сильнее молчания.
     *
     * Отвечаем коротко и зовём человека. Справку пациент получит по конкретному
     * вопросу, а не свалкой.
     */
    await escalate(ctx.companyId, conversation.id, "MISUNDERSTOOD", "Ассистент не смог ответить").catch(() => {});
    return respond(ctx, conversation.id, {
      text: "Секунду, передаю ваш вопрос администратору — он ответит здесь же.",
      buttons: mainMenu(),
    });
  }

  /**
   * Последняя проверка перед отправкой: модель могла пообещать записать,
   * хотя расписанием агент не распоряжается (§6). Такой ответ не отправляем —
   * пациент, которому пообещали запись, придёт к закрытой двери.
   */
  if (promisesBooking(answer)) {
    await escalate(ctx.companyId, conversation.id, "PATIENT_REQUEST", "Вопрос по записи").catch(() => {});
    return respond(ctx, conversation.id, { text: HANDOVER_REPLY, buttons: mainMenu() });
  }

  return respond(ctx, conversation.id, { text: answer, buttons: mainMenu() });
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
    return respond(ctx, conversationId, {
      text: greeting.trim() ? `Спасибо!\n\n${greeting.trim()}` : "Спасибо. Чем можем помочь?",
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
  // Согласие могли дать до появления карточки — переносим его в карточку.
  await materializeConsent(ctx.companyId, patientId, conversationId).catch(() => {});
  await escalate(ctx.companyId, conversationId, "PATIENT_REQUEST", "Пациент оставил номер для записи").catch(() => {});
  return { text: "Спасибо, передал(а) номер администратору — он свяжется и подберёт время." };
}
