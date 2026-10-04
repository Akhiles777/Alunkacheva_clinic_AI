import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { notifyStaff, escalationRecipients } from "@/lib/server/notify";
import { CLINIC_NAME } from "@/lib/brand";
import { getServices } from "./booking";
import { dedupeServices, patientServices, priceLine, priceListText } from "./price-list";
import { logAgentRun } from "./run-log";

/**
 * Идентификатор записи справочника, если он известен.
 *
 * `matchKnowledge` работает с обычными объектами и в тестах вызывается без
 * идентификаторов — там их и не должно быть. Пустой список честнее пустой
 * строки: «запись без номера» в журнал не пишем.
 */
function knowledgeIdOf(row: { id?: string }): string[] {
  return typeof row.id === "string" && row.id ? [row.id] : [];
}
import { confidentMatch, matchKnowledge, usableKnowledgeWhere } from "./knowledge";
import { answerLLM, phraseConfirmation, type Turn } from "./llm";
import { confirmationProblem, factsBlock, type StepFacts } from "./phrasing";
import { focusLine, focusOf, searchText } from "./focus";
import { patientVisitsContext, upcomingBookingLines } from "./patient-visits";
import { HANDBACK_HOURS } from "./handback-rule";
import {
  HANDOVER_REPLY,
  admitsInability,
  bookingPromiseFound,
  defersToDoctor,
  promisesHuman,
  refusesService,
  withoutBookingPromise,
  withoutHandoverPromise,
} from "./booking-promise";

/**
 * Сколько должно остаться от ответа после чистки, чтобы его стоило отправлять.
 * Короче — это обрывок фразы, а не ответ: лучше честно передать человеку.
 */
const MEANINGFUL_ANSWER_CHARS = 60;
import {
  asksAboutOwnBooking,
  asksForSlot,
  asksHowToBook,
  cantCome,
  complainsAboutClinic,
  medical,
  personalTopic,
  runningLate,
  scheduleTopic,
  statesOwnBooking,
  wantsToBook,
  wantsHuman,
  wantsReschedule,
  wasToldToCome,
} from "./triggers";
import {
  CONSENT_ACCEPT,
  CONSENT_DECLINE,
  consentRequestFor,
  grantConsent,
  materializeConsent,
  withoutConsentRequest,
  asksForConsent,
} from "./consent";
import { shouldNotifyEscalation, type EscalationReason } from "./escalation-window";
import { consentFromText, greetingUsed, isGreeting, menuActionFromText, supportsButtons } from "./text-actions";
import { messageBody, needsHuman, type IncomingAttachment } from "./attachments";
import { alreadyGreeted, alreadySaid } from "./repetition";
import {
  greetingText,
  shouldDropGreeting,
  startsWithGreeting,
  stripLeadingGreeting,
  withoutOffer,
} from "./greeting";
import { CLINIC_TZ, clinicDateKey, clinicMinuteOfDay, startOfClinicDay } from "@/lib/clinic-time";
import {
  audienceIn,
  candidateDays,
  clinicMoment,
  dayWhen,
  declinesSlot,
  hhmm,
  looksLikeOffer,
  parseStatusOffer,
  pickIn,
  slotCandidates,
  slotWhen,
  staffPhrase,
  timesIn,
  wantsSlot,
  forSomeoneElse,
  type StatusOffer,
} from "./status-slot";
import {
  DEFAULT_DURATION_MIN,
  checkSlot,
  holdSlot,
  markOffered,
  noteForAdmin,
  openSlotRows,
  openSlots,
  releaseOpen,
  recentHeld,
  releaseHeld,
  returningSelf,
  serviceForSlot,
  statusPostedAt,
  switchHold,
  type HoldResult,
  type OpenSlot,
  type SlotService,
} from "./slot-hold";
import { forMessenger } from "./messenger-text";
import { keepOneQuestion } from "./one-question";
import { FLOOD_WINDOW_MS, floodJustStarted, flooding } from "./flood";
import { ungroundedLinks, ungroundedNumbers } from "./grounding";
import { absoluteUrl, appUrl } from "@/lib/server/app-url";
import { inventedIndication } from "./indications";
import { asksAboutAge, infantRulesFirst, ungroundedAgeLimit, ungroundedAgeRefusal, withoutAgeRefusal } from "./age-limit";
import { focusedAnswer } from "./focused-answer";
import { audienceMentioned, unaskedAudience, withoutUnaskedAudience } from "./unasked-group";
import { matchServices, onlyWhomStated, whomAcross, whomFor, type Whom } from "./service-match";
import { staffConfirmedBooking } from "./booking-flow";
import { addressableName } from "./person-name";
import { bookingStep, type BookingStep } from "./booking-flow";
import {
  asksForIntake,
  asksForPersonalData,
  hasQuestion,
  inIntakeFlow,
  intakePrompt,
  looksLikeIntake,
  nameFromIntake,
  withoutPersonalDataRequest,
  asksDoctor,
  asksService,
  asksToChoose,
  asksWhom,
} from "./intake";
import { isAcknowledgement, smallTalkReply } from "./smalltalk";
import { stuckInMisunderstanding } from "./confusion";
import { splitQuote, withoutQuote } from "./quoted";
import { inHandoverFlow, rescheduleAsked, timeDetail } from "./handover-flow";
import { askSpecialist, specialistNames, specialistQueryPending } from "./specialist";
import { agentAskedSomething, nothingToAnswer } from "./unanswered-rule";
import { complexMedical, managementTopic } from "./specialist-rules";
import { WEEKDAY_WHEN, daysAsked, staffAsked, uniqueStaffAsked, whoWorks, withoutDays, wrongWorkday, daysAnswered } from "./workdays";

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
 *
 * Ровно столько же, сколько ждёт возврат диалога агенту, и это одно число не
 * случайно. Прежде пауза была двенадцать часов при возврате через сутки, и
 * статус «ведёт человек» снимать было некому: с двенадцатого часа агент уже
 * отвечал, а диалог всё ещё числился за сотрудником — добор неотвеченных его
 * обходил. Поведение и статус расходились, и понять по экрану, кто ведёт
 * разговор, было нельзя. Поэтому число одно на оба правила: меняется здесь —
 * меняется и там.
 */
export const HUMAN_TAKEOVER_HOURS = HANDBACK_HOURS;

export function humanTakeoverUntil(from: Date = new Date()): Date {
  return new Date(from.getTime() + HUMAN_TAKEOVER_HOURS * 3600 * 1000);
}

export interface AgentReply {
  text: string;
  /**
   * Диалог, которому принадлежит ответ.
   *
   * Нужен каналу, чтобы отметить исход отправки на самом сообщении. Без него
   * телеграм-вебхук выбрасывал результат, и все ответы навсегда оставались «в
   * очереди» — даже доставленные. Добор недоставленных для канала не работал
   * вовсе: он ищет пометку «не доставлено», а ставить её было некому.
   */
  conversationId?: string;
  buttons?: { text: string; data: string }[];
  /** Запросить номер телефона кнопкой Telegram. */
  askPhone?: boolean;
  /**
   * Текст о согласии написала сама платформа: её запрос со ссылкой на политику
   * или ответ на отказ. Такой текст `respond` не переписывает — правило про
   * просьбу о согласии ловит слова МОДЕЛИ, а не наши.
   */
  platformConsent?: boolean;
  /**
   * Ответ — шаг записи, даже если пациент не произнёс слово «записаться».
   *
   * Ответ на статус с окошком — «Хочу», «+», «Можно?» — это просьба записать,
   * но правила записи (`wantsToBook`) её не узнают. Без этого признака `respond`
   * счёл бы просьбу о данных преждевременной и вырезал её вместе с запросом
   * согласия: человек услышал бы «окошко свободно» и ничего о том, что дальше.
   */
  bookingContext?: boolean;
}

/**
 * Цитата, как её прислал провайдер (lib/integrations/whatsapp/webhook).
 *
 * Строку «В ответ на: «…»» в тексте пациент может напечатать и сам. Окошко из
 * статуса закрепляется только по цитате провайдера, автор которой — клиника.
 */
export interface AgentQuote {
  /** Идентификатор цитируемого сообщения; у статуса — идентификатор статуса. */
  id: string | null;
  /** Текст цитаты целиком. */
  text: string;
  /** Автор — клиника: совпал её номер или это известный нам её статус. */
  byClinic: boolean;
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
  /**
   * Текст, на который отвечаем. Ставится в начале обработки и нужен ровно для
   * одного: если человек поздоровался, ответ должен начинаться с приветствия —
   * какой бы веткой он ни был получен.
   *
   * Раньше приветствие добавлялось только к ответу модели, и на «Здравствуйте,
   * мы записаны были 20 августа, можно после 12» уходило «Конечно 🌿
   * Напишите…» — без единого приветственного слова. Заводить это в каждой
   * ветке значит однажды забыть в новой.
   */
  incomingText?: string;
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
  /** Для исходящих: «в очереди», пока канал не подтвердил отправку. */
  status?: "QUEUED" | "SENT" | "FAILED";
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
      ...(input.status ? { status: input.status } : {}),
      attachments: input.attachments?.length ? (input.attachments as unknown as object[]) : undefined,
    },
  });
  await prisma.conversation.update({
    where: { id: input.conversationId },
    data: {
      lastMessageAt: new Date(),
      ...(input.direction === "IN" ? { lastPatientMessageAt: new Date() } : {}),
      /**
       * Новое сообщение — новое ожидание.
       *
       * Счётчик напоминаний считает одно конкретное ожидание ответа. Без
       * сброса он упирался бы в предел навсегда: администратор ответил,
       * пациент написал через день — и о нём уже не напомнят ни разу.
       */
      remindedAt: null,
      reminderCount: 0,
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

  const created = await prisma.escalation
    .create({
      data: {
        companyId,
        conversationId,
        reason,
        urgency: reason === "MEDICAL_QUESTION" ? "HIGH" : "NORMAL",
        status: "OPEN",
      },
      select: { id: true },
    })
    .catch(() => null);

  /**
   * Эскалация — строка в журнале попыток агента.
   *
   * Это не сбой: часть тем агенту запрещена (§6), и передача человеку —
   * штатный исход. Но без этой строки нельзя посчитать, сколько разговоров
   * агент довёл сам, а сколько отдал, — а именно это и есть мера его пользы.
   */
  await logAgentRun({
    companyId,
    conversationId,
    outcome: "ESCALATED",
    escalationId: created?.id ?? null,
  });
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

/** Кто принимает — по именам режется справка под названного врача. */
async function staffNamesOf(companyId: string): Promise<string[]> {
  const rows = await prisma.staff.findMany({
    where: { companyId, isActive: true, deletedAt: null },
    select: { name: true },
  });
  return rows.map((r) => r.name);
}

async function clinicContext(
  companyId: string,
  question?: string,
  /**
   * Согласие уже получено — записи справочника про него в промпт не идут.
   *
   * Дословный путь такие записи уже отфильтровывал, а этот — нет. В результате
   * пациентка ответила «Да» на запрос согласия и следующей же репликой
   * услышала от модели: «нужно ваше согласие, ответьте „Согласна“ или „Не
   * согласна“». Согласие ведёт платформа, а не текст из справочника: для
   * человека это выглядит как неисправная программа.
   */
  consentGranted = false,
  /** Слова пациента за разговор, свежие первыми: врач и возраст, названные раньше. */
  talk: string[] = [],
): Promise<string> {
  const [services, knowledge, schedule, staff] = await Promise.all([
    getServices(companyId),
    prisma.knowledgeEntry.findMany({
      where: usableKnowledgeWhere(companyId),
      select: { id: true, topic: true, question: true, answer: true },
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
      select: { name: true, specialty: true, workdays: true },
    }),
  ]);

  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const days = ["", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

  // Без разметки: этот текст и уходит в модель, и показывается пациенту.
  // Символы # и * в мессенджере выглядят как мусор.
  const lines = [`Клиника «${CLINIC_NAME}».`];

  /**
   * Услуги, подходящие под вопрос, — отдельно и первыми.
   *
   * В прайсе шесть десятков строк, среди них «Остеопатия — дети, приём Ирины»
   * за 4900 и взрослый приём за 8000. На вопрос «хотела ребёнка записать»
   * модель назвала взрослую цену. Выбор из шести десятков похожих названий —
   * работа для кода: подходящие отбираем сами, модель формулирует ответ, но
   * цену не выбирает.
   */
  let matched = question ? matchServices(question, services) : [];
  /**
   * Вопрос о цене без названной услуги — про приём врача, названного раньше.
   *
   * «В какую стоимость консультация» само по себе совпадает с позицией прайса
   * «Консультация — 1000 ₽», и модель назвала её, хотя разговор шёл об Ирине
   * Алилгаджиевне и двухмесячном ребёнке. Если услуга в вопросе названа
   * конкретно («а БОС сколько?») — отвечаем про неё, разговор не мешает.
   */
  const namedHere = question
    ? matchServices(serviceQuery(question), services, 6, 0.5).length > 0
    : false;
  let chosenDoctor: string | null = null;
  if (!namedHere && talk.length > 0) {
    const offer = await doctorOffer(companyId, talk).catch(() => null);
    if (offer) {
      const fit = forAge(offer.services, whomAcross(talk));
      matched = fit.length > 0 ? fit : offer.services;
      chosenDoctor = offer.doctor;
    }
  }
  if (matched.length > 0) {
    lines.push("", "ПОДХОДИТ ПОД ВОПРОС (цену и длительность бери только отсюда):");
    /**
     * Название услуги — ценник, а не регламент.
     *
     * В прайсе стоит «Детский прием до 10 л», чтобы отличить две цены. Агент
     * прочитал это как правило приёма и отказал ребёнку 11 лет, хотя в справке
     * клиники написано «мальчиков принимаем до 14 лет включительно».
     */
    lines.push(
      "Возраст в названии услуги — это только про цену. Кого принимают и с какого возраста, " +
        "бери ТОЛЬКО из справки клиники ниже; нет там — передай администратору, не отказывай сам.",
    );
    for (const s of patientServices(matched)) lines.push(priceLine(s));
    /**
     * Врач выбран — чужие строки прайса к нему не относятся. Без этой строки
     * модель отвечала «приём 5000 ₽, а консультация отдельно — 1000 ₽», хотя
     * у этого врача отдельной консультации нет: 1000 ₽ — чужая позиция прайса.
     */
    if (chosenDoctor) {
      lines.push(
        `Пациент записывается к врачу: ${chosenDoctor}. Выше — все услуги этого врача. ` +
          "Цены других строк прайса к нему не относятся: не называй их и не говори, что у этого врача есть что-то ещё.",
      );
    }

    /**
     * Кто ведёт эти услуги — чтобы агент не спрашивал о том, что знает.
     *
     * Пациентка написала «ребёнку 6 лет, хотела записаться на консультацию», а
     * получила встречный вопрос: «к какому специалисту хотели бы попасть —
     * например, к БОС-терапевту Ирине Омаровой?». БОС-терапию в клинике ведёт
     * один человек, спрашивать не о чем. Кто что ведёт, видно по визитам, и
     * это надёжнее любой настройки.
     */
    const runners = await Promise.all(
      patientServices(matched).map(async (s) => ({
        title: s.title,
        staff: await staffNamesForService(companyId, s.id),
      })),
    );
    const known = runners.filter((r) => r.staff.length > 0);
    if (known.length > 0) {
      lines.push("", "Кто ведёт эти услуги:");
      for (const r of known) lines.push(`• ${r.title}: ${r.staff.join(", ")}`);
      lines.push(
        "Если услугу ведёт один специалист, не спрашивай, к кому записать, — просто назови его.",
      );
    }
  }

  /**
   * Что именно спросили — отдельной строкой и до справочника.
   *
   * Пациент спросил цену детского приёма у названного врача, а получил весь
   * раздел справочника: два остеопата, четыре цены. Запись справочника
   * покрывает несколько случаев сразу, и модель печатала её целиком. Значит
   * надо прямо сказать, какой из случаев нужен.
   */
  const focus = question ? focusLine(focusOf(question, whomFor(question), staff.map((p) => p.name))) : "";
  if (focus) lines.push("", focus);

  /**
   * Модели даём тот же список, что видит пациент.
   *
   * Заготовки с нулевой и рублёвой ценой она цитировала как настоящие цены —
   * «Сдача анализов — 1 ₽» при чеке в несколько тысяч. И «0 мин» она тоже
   * зачитывала: незаполненное поле выглядело как длительность приёма.
   */
  lines.push("", "Все услуги и цены:");
  /**
   * Врач выбран, а вопрос общий («сколько стоит консультация») — чужие строки с
   * тем же общим словом модели не показываем. Просьба «не называй чужие цены»
   * не держалась: модель отвечала «приём 5000 ₽, а консультация как отдельная
   * услуга — 1000 ₽», и человек снова видел цену, к его врачу не относящуюся.
   */
  const generic = /консультаци|при[её]м/iu;
  const ownIds = new Set(matched.map((m) => m.id));
  for (const s of patientServices(services)) {
    if (chosenDoctor && generic.test(s.title) && !ownIds.has(s.id)) continue;
    lines.push(priceLine(s));
  }
  lines.push("", "Часы работы:");
  for (const d of schedule) lines.push(`${days[d.weekday]}: ${hhmm(d.startMinute)}–${hhmm(d.endMinute)}`);
  const closed = [1, 2, 3, 4, 5, 6, 7].filter((w) => !schedule.some((d) => d.weekday === w));
  if (closed.length) lines.push(`Выходной: ${closed.map((w) => days[w]).join(", ")}`);
  if (staff.length) {
    lines.push("", "Принимают:");
    for (const p of staff) {
      /**
       * Дни приёма врача — рядом с его именем.
       *
       * График клиники и график врача — разные вещи. Пациентка спросила
       * «работаете ли в выходные и сколько стоит приём» и получила цены обоих
       * остеопатов, хотя в субботу принимает только один. Ответ был верен про
       * клинику и неверен про врача, и администратору пришлось поправлять.
       *
       * Дни не заданы — не пишем ничего: пустая настройка не значит «не
       * работает», и говорить об этом пациенту нельзя.
       */
      const when = p.workdays.length
        ? `, принимает: ${p.workdays.slice().sort((a, b) => a - b).map((w) => days[w]).join(", ")}`
        : "";
      lines.push(`• ${p.name}${p.specialty ? ` — ${p.specialty}` : ""}${when}`);
    }
    if (staff.some((p) => p.workdays.length)) {
      lines.push(
        "Дни приёма у врачей разные: прежде чем называть врача на конкретный день, сверься с этим списком.",
      );
    }
  }
  const usable = consentGranted
    ? knowledge.filter((k) => !aboutConsent(k.topic) && !aboutConsent(k.question))
    : knowledge;
  const relevant = pickRelevant(usable, question, talk);
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
  /** Слова пациента за разговор: про малыша говорят раньше, чем спрашивают. */
  talk: string[] = [],
): { topic: string; question: string; answer: string }[] {
  const byScore = infantRulesFirst(
    rows,
    question
      ? rows
          .map((row) => ({ row, score: matchKnowledge(question, [row])?.score ?? 0 }))
          .sort((a, b) => b.score - a.score)
          .filter((x) => x.score > 0)
          .map((x) => x.row)
      : [],
    question,
    talk,
  );

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
 * Открыта ли просьба записать — та, по которой запись ещё не оформлена.
 *
 * Живой диалог 30 сентября: администратор предложил время, пациентка ответила
 * «Да, запиши пожалуйста», администратор записал и прислал подтверждение. На
 * следующий день агент дописал «пришлите ФИО, возраст и причину обращения»:
 * вчерашнее «запиши» считалось незакрытой просьбой.
 *
 * Первая правка закрывала просьбу ЛЮБОЙ репликой сотрудника после неё — и
 * сломала запись целиком. Живой диалог 2 октября: «К остеопату хотела
 * записать» → «к кому?» → «К Ирине Алилгаджиевне» — и ни согласия, ни просьбы
 * о данных. Репликой «сотрудника» там оказалось эхо ответа самого агента
 * (телефон клиники присылает наш текст обратно, и с другим переносом строки
 * он не узнавался): одна такая строка закрывала запись и заодно делала
 * человека «знакомым», то есть снимала вопрос о согласии.
 *
 * Поэтому закрывает просьбу только то, что запись ОФОРМЛЕНА: в YCLIENTS у
 * пациента появилась запись, созданная после просьбы, или сотрудник прямо
 * написал «записала», «вы записаны». «Здравствуйте» администратора, его
 * вопрос или эхо нашего ответа запись не оформляют.
 */
/**
 * Просьба записаться — и вопрос о свободном окне тоже: «на 12 октября к Ирине
 * А. есть окошко?» спрашивают, чтобы записаться. Пока он просьбой не считался,
 * на «взрослый» агент называл цену и замолкал — ни согласия, ни данных.
 */
const asksToBookOrSlot = (text: string) => wantsToBook(text) || asksForSlot(text);

async function bookingRequestOpen(conversationId: string, own: string): Promise<boolean> {
  return (await bookingState(conversationId, own)) === "open";
}

/**
 * Где запись: просьбы не было, просьба открыта или запись уже оформлена.
 * Третье нужно отдельно: оформленному пациенту данные не нужны, и просьба
 * прислать ФИО от модели ему не уходит (живой диалог 30 сентября).
 */
async function bookingState(conversationId: string, own: string): Promise<"none" | "open" | "booked"> {
  if (asksToBookOrSlot(own)) return "open";
  const conv = await prisma.conversation
    .findUnique({ where: { id: conversationId }, select: { patientId: true, companyId: true } })
    .catch(() => null);
  const since = new Date(Date.now() - HISTORY_DAYS * 24 * 3600 * 1000);
  const scope = conv?.patientId
    ? { companyId: conv.companyId, conversation: { patientId: conv.patientId } }
    : { conversationId };
  const request = (
    await prisma.message
      .findMany({
        where: { ...scope, direction: "IN", deletedAt: null, isDraft: false, createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { body: true, createdAt: true },
      })
      .catch(() => [])
  ).find((m) => asksToBookOrSlot(withoutQuote(m.body)));
  if (!request) return "none";

  const bookedByStaff = await prisma.message
    .findMany({
      where: { ...scope, authorType: "STAFF", deletedAt: null, isDraft: false, createdAt: { gt: request.createdAt } },
      select: { body: true },
      take: 20,
    })
    .then((rows) => rows.some((m) => staffConfirmedBooking(m.body)))
    .catch(() => false);
  if (bookedByStaff) return "booked";

  if (conv?.patientId) {
    const booked = await prisma.appointment
      .count({
        where: {
          companyId: conv.companyId,
          patientId: conv.patientId,
          deletedAt: null,
          status: { not: "CANCELLED" },
          createdAtYclients: { gt: request.createdAt },
        },
      })
      .catch(() => 0);
    if (booked > 0) return "booked";
  }
  return "open";
}

/**
 * Ответ бота всегда попадает в переписку. Раньше часть веток возвращала текст
 * пациенту, но не сохраняла его: в инбоксе диалог выглядел как молчание бота,
 * а администратор не понимал, что уже было сказано.
 */
/** Кнопки ответа на вопрос о согласии. */
function consentButtons() {
  return [
    { text: "Да, согласен(на)", data: CONSENT_ACCEPT },
    { text: "Нет", data: CONSENT_DECLINE },
  ];
}

/**
 * Короткое напоминание вместо полного текста согласия.
 *
 * Полную формулировку с ссылкой человек уже видел; повторять её целиком на
 * каждую просьбу о данных — та самая стена, из-за которой разговоры и
 * запирались.
 */
const CONSENT_REMINDER =
  "Чтобы передать данные администратору, нужно ваше согласие на обработку персональных данных — " +
  "ответьте, пожалуйста, «Да» или «Нет».";

/** Как называется канал в тексте для человека. */
function channelLabel(channel: AgentChannel): string {
  return channel === "WHATSAPP" ? "WhatsApp" : channel === "INSTAGRAM" ? "Instagram" : "Telegram";
}

/**
 * Заходила ли в этом диалоге речь о записи.
 *
 * Согласие нужно под сбор данных, а данные собираются ради записи. Пациент,
 * спросивший цену, ничего не записывает — и требовать от него согласия не за
 * что: «А ребёнку 6 лет сколько?» получало цену и следом юридический текст.
 * Смотрим последние реплики пациента: просьба записаться могла прозвучать
 * раньше, чем модель дошла до данных.
 */
async function bookingAsked(conversationId: string): Promise<boolean> {
  const rows = await prisma.message
    .findMany({
      where: { conversationId, direction: "IN", deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: { body: true },
    })
    .catch(() => []);
  return rows.some((m) => wantsToBook(m.body) || wantsReschedule(m.body));
}

/**
 * Что человек выбрал — одной строкой и только фактами.
 *
 * Живой диалог: пациентка ответила «Взрослый Разият Резванова», то есть назвала
 * и врача, и вид приёма, — и получила в ответ ОДИН юридический текст про
 * согласие. Выбор она озвучила, а подтверждения не услышала: со стороны это
 * выглядит так, будто её не поняли, и следующий шаг непонятен.
 *
 * Так получилось не из-за пропущенного правила: модель уложила подтверждение и
 * просьбу о данных в одно предложение, а просьбу мы до согласия вырезаем — и
 * вместе с ней уходило подтверждение.
 *
 * Строку собираем сами из прайса: услуга, цена, длительность и врач, если он
 * назван. Ничего, кроме этого, — суммы и названия берутся из справочника, а не
 * из слов модели (§6.2).
 */
async function chosenFacts(companyId: string, conversationId: string): Promise<string | null> {
  return choiceLine(await conversationChoice(companyId, conversationId));
}

/** Выбор по словам пациента в этой переписке (без цитат), свежие первыми. */
async function conversationChoice(companyId: string, conversationId: string): Promise<TalkChoice> {
  const rows = await prisma.message
    .findMany({
      where: { conversationId, direction: "IN", deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { body: true },
    })
    .catch(() => []);
  return talkChoice(
    companyId,
    rows.map((m) => withoutQuote(m.body)).filter((t) => t.trim().length > 0),
  );
}

/** Та же строка с хвостом про администратора — для ответа перед согласием. */
async function chosenLine(companyId: string, conversationId: string): Promise<string | null> {
  const facts = await chosenFacts(companyId, conversationId);
  return facts ? `${facts} Передам администратору — он подберёт время.` : null;
}

/**
 * Что сказал сам пациент в этом разговоре.
 *
 * Только его слова: цитату нашего же текста снимаем (`withoutQuote`), иначе
 * ответ на справку про мужчин «подтверждал» бы, что про мужчин спрашивали —
 * той же ошибкой, из-за которой «Ок» однажды сошло за согласие на обработку
 * данных. Текущее сообщение передаём отдельно: в базу оно к этому моменту
 * попасть успело, но полагаться на это нельзя.
 */
async function patientWords(conversationId: string, incoming?: string | null): Promise<string[]> {
  const rows = await prisma.message
    .findMany({
      where: { conversationId, direction: "IN", deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: { body: true },
    })
    .catch(() => []);
  return [incoming ?? "", ...rows.map((m) => withoutQuote(m.body))].filter(Boolean);
}

/**
 * Администратор уже ответил на это сообщение.
 *
 * Сравниваем последнюю реплику сотрудника с последним входящим: если сотрудник
 * написал ПОЗЖЕ, разговор уже у него. Так правило работает и для добора
 * неотвеченных, где сообщение пациента старое: пауза после перехвата
 * проверяется на входе, а этот случай виден только у выхода.
 */
async function staffAnsweredMeanwhile(conversationId: string): Promise<boolean> {
  const [staff, incoming] = await Promise.all([
    prisma.message
      .findFirst({
        where: { conversationId, authorType: "STAFF", deletedAt: null, isDraft: false },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      })
      .catch(() => null),
    prisma.message
      .findFirst({
        where: { conversationId, direction: "IN", deletedAt: null, isDraft: false },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      })
      .catch(() => null),
  ]);
  if (!staff || !incoming) return false;
  return staff.createdAt > incoming.createdAt;
}

async function respond(
  ctx: AgentContext,
  conversationId: string,
  reply: AgentReply,
): Promise<AgentReply | null> {
  /**
   * Согласие — перед запросом персональных данных, и ни минутой раньше (§7).
   *
   * Так написано в инструкции клиники: сначала определить услугу, назвать цену
   * и длительность, потом взять согласие, и только потом просить ФИО, возраст
   * и жалобу. Стена на входе была нашей самодеятельностью: человек спрашивал
   * «сколько стоит остеопатия?» и первым, что слышал от клиники, был
   * юридический текст.
   *
   * Проверка стоит здесь, а не в ветках, потому что здесь ЕДИНСТВЕННЫЙ выход
   * наружу: сколько бы веток ни появилось потом, ни одна не сможет попросить
   * данные, минуя согласие. Просьбу вырезаем, остальное — услугу, цену,
   * длительность — оставляем: она человеку полезна.
   */
  /**
   * Согласие уже есть — просьбу о нём вырезаем.
   *
   * Модель повторяет её за нами: пациент ответил «Да», получил приветствие и
   * следом «теперь мне нужно ваше согласие… согласны ли вы?». Разговор
   * закольцевался на том, что уже сделано.
   */
  const consentDone = await prisma.conversation
    .findUnique({ where: { id: conversationId }, select: { consentGrantedAt: true } })
    .catch(() => null);
  if (consentDone?.consentGrantedAt) {
    const cleaned = withoutConsentRequest(reply.text);
    if (cleaned.length >= 20 && cleaned !== reply.text) {
      reply = { ...reply, text: cleaned };
    }
  }

  /**
   * Просьба о согласии СЛОВАМИ МОДЕЛИ — туда же, что и просьба о данных.
   *
   * Модель спросила «Вы согласны?» своими словами: без ссылки на политику и без
   * отметки, что согласие спрошено. «Да» на это платформа не принимала и
   * спрашивала согласие второй раз, по форме. Теперь такое предложение
   * заменяется запросом платформы тут же — и первое же «Да» засчитывается.
   */
  if (asksForPersonalData(reply.text) || (asksForConsent(reply.text) && !reply.platformConsent)) {
    /**
     * Спросили один раз — и замолчали: так данные собирались БЕЗ согласия.
     *
     * `consentRequestFor` возвращает вопрос только в первый раз; дальше он
     * молчит, потому что второй раз спрашивать незачем. На этом молчании
     * просьба прислать ФИО проходила насквозь: мама получила запрос согласия,
     * не ответила на него, а через две реплики прислала имена и возраст обоих
     * детей — и они были приняты.
     *
     * Поэтому решает не наличие вопроса, а факт согласия. Нет согласия —
     * просьбу вырезаем всегда, а сам вопрос задаём либо целиком (в первый
     * раз), либо коротким напоминанием.
     */
    const granted = await prisma.conversation
      .findUnique({ where: { id: conversationId }, select: { consentGrantedAt: true } })
      .catch(() => null);
    /**
     * Согласие идёт ВМЕСТЕ с просьбой о данных, а не вместо разговора.
     *
     * Просьбу о данных мы отсюда вырезаем — и если после этого ответ всё ещё
     * спрашивает, на какую услугу или к какому врачу, значит шаг с данными не
     * наступил: человек только выбирает. Согласие рядом с таким вопросом
     * выглядит стеной на пустом месте и сбивает порядок клиники (услуга и
     * цена → согласие → данные).
     *
     * Живой диалог: «Хотела девочку записать к остеопату» → «к какому врачу
     * хотите? Прежде чем продолжить: нам нужно ваше согласие…» → «Да» → и
     * разговор перескочил сразу к ФИО, минуя цены и выбор врача.
     *
     * Молчим здесь совсем: `consentRequestFor` пометил бы диалог спрошенным, и
     * на настоящем шаге данных вопрос уже не задался бы.
     */
    const stillChoosing = asksToChoose(
      withoutConsentRequest(withoutPersonalDataRequest(reply.text)),
    );
    /**
     * Согласие спрашиваем только там, где речь о записи.
     *
     * «Сколько стоит остеопатия?» → цена → «А ребёнку 6 лет сколько?» → цена
     * И ЮРИДИЧЕСКИЙ ТЕКСТ: модель приписала к ответу просьбу прислать данные,
     * мы её вырезали, а согласие осталось. Человек ничего не записывал и
     * данных не присылал — спрашивать его не о чем (§7).
     */
    const aboutBooking =
      reply.bookingContext === true ||
      (ctx.incomingText ? wantsToBook(ctx.incomingText) : false) ||
      (await bookingAsked(conversationId));
    if (granted && !granted.consentGrantedAt && (stillChoosing || !aboutBooking)) {
      // Вопрос о выборе короткий («Для взрослого или для ребёнка?»), и порога
      // длины здесь быть не должно: иначе просьба о данных осталась бы в тексте.
      const kept = withoutConsentRequest(withoutPersonalDataRequest(reply.text));
      if (kept) reply = { ...reply, text: kept };
    } else if (granted && !granted.consentGrantedAt) {
      const request = await consentRequestFor(ctx.companyId, conversationId).catch(() => null);
      // Свой пациент: согласие могло проставиться прямо сейчас — перечитываем.
      const after = await prisma.conversation
        .findUnique({ where: { id: conversationId }, select: { consentGrantedAt: true } })
        .catch(() => null);
      if (!after?.consentGrantedAt) {
        /**
         * Снимаем и просьбу модели о согласии, а не только просьбу о данных.
         *
         * Ниже мы добавляем СВОЙ запрос согласия со ссылкой на политику.
         * Оставленная рядом формулировка модели давала два разных запроса
         * подряд в одном сообщении: «Пожалуйста, ответьте: „Согласен/
         * Согласна“» и следом «Ответьте „Да“ или „Нет“». Согласие ведёт
         * платформа — значит и просит его она одна.
         */
        const kept = withoutConsentRequest(withoutPersonalDataRequest(reply.text));
        const ask = request ? request.text + consentHint(ctx.channel) : CONSENT_REMINDER;
        /**
         * Пустой остаток — значит вырезали весь ответ, и человек увидит одно
         * согласие. Подтверждаем выбор фактами из прайса (`chosenLine`): он
         * назвал врача и вид приёма, и услышать это обратно он вправе.
         */
        /**
         * И остаток без цены — тоже. Порядок клиники: цена, потом согласие.
         * Модель после выбора врача писала «Время подберёт администратор» и
         * просьбу о данных; просьбу мы вырезаем, и человек получал согласие,
         * так и не услышав, сколько стоит приём у выбранного врача. Строку из
         * прайса ставим, только если в ней есть цена: без неё она ничего не
         * добавляет.
         */
        let body: string | null = kept || null;
        if (!kept) {
          body = await chosenLine(ctx.companyId, conversationId).catch(() => null);
        } else if (!hasPrice(kept)) {
          const facts = await chosenFacts(ctx.companyId, conversationId).catch(() => null);
          if (facts && hasPrice(facts)) body = `${kept}\n${facts}`;
        }
        reply = {
          ...reply,
          text: body ? `${body}\n\n${ask}` : ask,
          buttons: request?.buttons ?? consentButtons(),
        };
      }
    }
  }

  /**
   * Справка о тех, о ком не спрашивали, наружу не уходит.
   *
   * Запись «Приём мужчин» ушла пациентам три раза подряд, и ни один из них про
   * мужчин не говорил: женщина, записанная на остеопатию, прочитала, что
   * клиника взрослых мужчин не принимает, и получила телефон чужого врача. В
   * промпте правило «отвечай на заданный вопрос, а не пересказывай запись»
   * стоит дважды — и нарушалось всё равно, поэтому проверка кодовая и стоит
   * здесь, у единственного выхода наружу: какой бы ветка ни составила текст —
   * модель, дословная справка или запасной путь, — проверяется он один раз
   * (lib/agent/unasked-group).
   *
   * Убираем только такие предложения: модель успевает в одном сообщении
   * назвать цену по делу и приписать абзац из чужой записи. Не осталось
   * ничего — зовём администратора, а не отправляем обрывок.
   */
  if (audienceMentioned(reply.text)) {
    const spoken = await patientWords(conversationId, ctx.incomingText);
    const unasked = unaskedAudience(reply.text, spoken);
    if (unasked) {
      console.error(`[agent] из ответа убрана справка не по делу: «${unasked}»`);
      await escalate(
        ctx.companyId,
        conversationId,
        "MISUNDERSTOOD",
        "Ассистент ответил справкой не по вопросу",
      ).catch(() => {});
      const kept = withoutUnaskedAudience(reply.text, spoken);
      reply = {
        ...reply,
        text:
          kept.length >= MEANINGFUL_ANSWER_CHARS
            ? kept
            : "Уточню у администратора и напишу здесь же. " +
              "Могу пока рассказать про услуги, цены, адрес и часы работы.",
      };
    }
  }

  /**
   * Администратор ответил, пока агент думал, — молчим.
   *
   * Живой диалог: пациентка спросила «К остеопату записаться можно?», через
   * секунды администратор написал «Добрый день Марият» — и следом пришёл ответ
   * агента. Пауза после перехвата проверяется на ВХОДЕ, а ответ модели идёт
   * несколько секунд: к моменту отправки сотрудник уже в разговоре. Бот,
   * перебивающий администратора, — худший дефект этой системы (§6.4), и
   * единственное место, где это можно поймать, — выход наружу.
   */
  if (await staffAnsweredMeanwhile(conversationId)) {
    await logAgentRun({
      companyId: ctx.companyId,
      conversationId,
      outcome: "SUPPRESSED",
      error: "администратор ответил раньше — агент не перебивает",
    });
    return null;
  }

  /**
   * Поздоровались с нами — здороваемся в ответ. Одно место на все ветки.
   *
   * Но не второй раз за день. Диалог возвращается агенту через четыре часа
   * (§6.4), и человек, разговаривавший с клиникой утром, спрашивает адрес — а
   * слышит «Здравствуйте!» от собеседника, который час назад отвечал ему на
   * другой вопрос. Это выдаёт автоответчик и читается как потеря памяти.
   *
   * Главное правило при этом остаётся главным: **поздоровался человек —
   * здороваемся и мы**, сколько бы раз за день это ни повторилось.
   * «Здравствуйте, напомните адрес» получает «Здравствуйте! Наш адрес…».
   * Молчим только тогда, когда человек не здоровался сам, — решает
   * shouldDropGreeting, и правило проверено тестами отдельно от базы.
   */
  const drop =
    ctx.incomingText && shouldDropGreeting(ctx.incomingText, await greetedToday(conversationId));
  const withHello = ctx.incomingText
    ? drop
      ? stripLeadingGreeting(reply.text)
      : greetIfNeeded(ctx.incomingText, reply.text, "")
    : reply.text;
  /**
   * Один уточняющий вопрос за раз — правило клиники, и оно нарушалось.
   *
   * Просьбами в промпте не лечится: модель задавала два вопроса подряд, и
   * первый бывал про то, что пациент уже сказал. Режем здесь, в единственном
   * выходе наружу, — текст от этого только сокращается.
   */
  const text = forMessenger(keepOneQuestion(withHello));
  /**
   * Ответ агента сохраняем как «в очереди», а не «отправлено».
   *
   * Отправка идёт после и может не удаться: провайдер не принял, сеть легла.
   * Пока сохранялось «отправлено», такой ответ выглядел доставленным — в
   * инбоксе он есть, а у пациента его нет, и никто об этом не знает. Отметку
   * ставит тот, кто отправил (см. lib/agent/unanswered и вебхуки каналов).
   */
  await saveMessage({
    companyId: ctx.companyId,
    conversationId,
    channel: ctx.channel,
    direction: "OUT",
    authorType: "BOT",
    body: text,
    status: "QUEUED",
  });
  return { ...reply, text, conversationId };
}

// ─────────────────────────────────────────────── обработка

/**
 * Позвать человека, пока ждём согласие.
 *
 * Мама написала «У сына ДЦП, 4 года. Остеопатия ему поможет?» — и получила
 * только юридический текст. Эскалации не завелось, администратор о вопросе не
 * узнал: проверка медицинских тем стоит ПОСЛЕ согласия, и до неё дело не
 * доходило. То же с фотографией направления — прочитать её агент не может и
 * обязан позвать человека, а звал только с третьего сообщения.
 *
 * Ответ пациенту при этом остаётся прежним: без согласия переписку мы не
 * ведём (§7). Но человека зовём сразу — эскалация это внутренняя пометка,
 * ничьих персональных данных она не обрабатывает.
 *
 * Возвращает приписку для ответа или пустую строку: пациент должен видеть,
 * что его вопрос уже у человека, иначе стена читается как отказ.
 */
async function callHumanWhileWaitingConsent(
  ctx: AgentContext,
  conversationId: string,
  own: string,
  attachments: IncomingAttachment[],
): Promise<string> {
  const called = await (async () => {
    if (attachments.length > 0 && needsHuman(attachments)) {
      await escalate(
        ctx.companyId,
        conversationId,
        "PATIENT_REQUEST",
        `Пациент прислал ${attachments.map((a) => a.label).join(", ")}`,
      ).catch(() => {});
      return true;
    }
    if (medical(own)) {
      await escalate(ctx.companyId, conversationId, "MEDICAL_QUESTION", "Медицинский вопрос до согласия").catch(() => {});
      return true;
    }
    if (personalTopic(own) || wantsHuman(own)) {
      await escalate(ctx.companyId, conversationId, "PATIENT_REQUEST", "Личный вопрос или жалоба до согласия").catch(() => {});
      return true;
    }
    return false;
  })();
  return called ? "\n\nВаш вопрос уже у администратора — он ответит здесь же." : "";
}


export async function handlePatientMessage(
  ctx: AgentContext,
  input: {
    text?: string;
    phone?: string;
    callbackData?: string;
    externalId?: string;
    /** Голосовые, фото, видео, документы — см. lib/agent/attachments.ts. */
    attachments?: IncomingAttachment[];
    /** Сообщение уже сохранено: это повторная попытка ответить. */
    alreadySaved?: boolean;
    /**
     * Номер, известный из самого канала. В WhatsApp он есть всегда: адрес
     * чата и есть телефон. Спрашивать его отдельно бессмысленно, а без
     * привязки диалог висит без карточки — администратор не видит ни истории
     * визитов, ни прошлых обращений.
     */
    knownPhone?: string | null;
    /**
     * Цитата, как её прислал провайдер. Нужна окошкам из статусов: закреплять
     * окошко по строке, которую пациент мог напечатать сам, нельзя.
     */
    quote?: AgentQuote | null;
  },
): Promise<AgentReply | null> {
  const conversation = await loadConversation(ctx);
  const attachments = input.attachments ?? [];
  const channelName = channelLabel(ctx.channel);

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
  /**
   * Смотрим на слова пациента, без цитаты: она принадлежит собеседнику, и
   * жалоба в процитированном тексте — не жалоба этого сообщения (lib/agent/quoted).
   */
  const askedByPatient = withoutQuote(input.text ?? "");
  /**
   * Присланная анкета — не просьба позвать человека, а данные для записи.
   *
   * Живой диалог: мама прислала данные второго и третьего ребёнка —
   * «Аламова Айша Гамзатовна, 15 лет. Жалобы на спину» — и агент промолчал.
   * Слово «жалобы» здесь про симптомы, а не про жалобу на клинику, но правило
   * читало его как просьбу человека и, поскольку эскалация уже была открыта,
   * молчало. Данные приняты, а человек об этом не узнал: он ждёт хотя бы
   * «передал(а) администратору».
   */
  const staffForIntake = await staffNamesOf(ctx.companyId).catch(() => []);
  const askedForAdmin =
    !looksLikeIntake(askedByPatient, staffForIntake) &&
    (personalTopic(askedByPatient) || wantsHuman(askedByPatient));

  /**
   * Агент выключен в этом диалоге насовсем — решением человека.
   *
   * В пациентский канал пишут и сотрудники клиники между собой: «придёт
   * Гулбарият, взять ОАК, оплату не брать». Агент отвечает им как пациенту и
   * не может понять, что разговор не о нём. Отличить сотрудника от пациента
   * ему нечем, а человеку есть — поэтому выключатель отдан человеку, и срок у
   * него не истекает, в отличие от паузы после перехвата.
   *
   * Сообщения при этом сохраняются и уведомления уходят как обычно: выключен
   * ответ агента, а не переписка.
   */
  /**
   * ПОЧЕМУ молчим — записываем словами.
   *
   * «SUPPRESSED 29» в журнале не отвечает ни на один вопрос: у молчания три
   * разные причины, и лечатся они по-разному. Владелец смотрел на это число и
   * видел «бот не работает», хотя двадцать девять раз бот молчал правильно —
   * в диалогах, которые вели администраторы.
   */
  const silence: string | null = conversation.agentDisabled
    ? "агент выключен в диалоге человеком"
    : conversation.status === "HUMAN_TAKEOVER" &&
        conversation.botPausedUntil !== null &&
        conversation.botPausedUntil > new Date()
      ? `пауза после ответа сотрудника до ${conversation.botPausedUntil.toISOString().slice(11, 16)} UTC`
      : openEscalation !== null && askedForAdmin
        ? "открытая эскалация и просьба позвать человека"
        : null;

  const paused = silence !== null;
  if (paused) {
    /**
     * Молчание намеренное: диалог ведёт человек. В надёжности агента такие
     * строки не участвуют — он не пытался и не мог ответить.
     */
    await logAgentRun({
      companyId: ctx.companyId,
      conversationId: conversation.id,
      outcome: "SUPPRESSED",
      // Причина молчания — в том же поле, что и причина сбоя: это ответ на
      // вопрос «почему бот не ответил», а он один и тот же по сути.
      error: silence,
    });
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

      /**
       * Выключенный агент всё равно доносит СЛОЖНЫЙ вопрос до врача.
       *
       * Выключатель нужен там, где в пациентском канале переписываются
       * сотрудники: агент им мешал и тратил модель впустую. Но человек с
       * настоящим вопросом о здоровье не должен из-за этого остаться без
       * ответа — а он остаётся: администратор увидит сообщение и всё равно
       * пойдёт к врачу.
       *
       * Отвечать пациенту агент по-прежнему не будет; ответ придёт словами
       * врача, когда она ответит. Мелочи не пересылаются: служебное «взять
       * ОАК, оплату не брать» под сложный вопрос не подпадает, и врача из-за
       * него не побеспокоят.
       *
       * Только для выключателя. Пауза после ответа сотрудника — другое дело:
       * там администратор уже в разговоре и сам решит, звать ли врача.
       */
      if (conversation.agentDisabled) {
        const own = withoutQuote(input.text ?? "");
        const said = await recentTurns(conversation.id);
        const asked = questionForDoctor(own, said);
        const kind = managementTopic(own)
          ? ("MANAGEMENT" as const)
          : medical(own) && complexMedical(asked)
            ? ("MEDICAL" as const)
            : null;
        if (kind) {
          await askSpecialist({
            companyId: ctx.companyId,
            conversationId: conversation.id,
            patientId: conversation.patientId,
            kind,
            patientName: await patientNameFor(conversation.id),
            channelLabel: channelName,
            serviceId: kind === "MEDICAL" ? await serviceInTalk(ctx.companyId, own, said) : null,
          }).catch(() => ({ sent: false }));
        }
      }
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
    /**
     * Привязали — значит знаем, уже в этом сообщении.
     *
     * Карточка обновлялась в базе, а объект диалога в памяти оставался с
     * пустым patientId — и всё, что дальше зависит от «знаем ли мы человека»,
     * работало как с незнакомцем. На первом же сообщении: «Записана на 8
     * сентября» получало «уточню у администратора», хотя запись лежала в базе;
     * согласие спрашивалось у пациентки с визитами. Со второго сообщения всё
     * налаживалось само — и потому дефект не был виден в разборах.
     */
    const linked = await linkByPhone(ctx, conversation.id, input.knownPhone).catch(() => null);
    if (linked) conversation.patientId = linked;
  }

  const text = (input.text ?? "").trim();
  /**
   * Слова самого пациента — без цитаты, на которую он отвечал.
   *
   * Решения принимаем по ним: «Запишите пожалуйста племянника моего» в ответ
   * на сообщение клиники «Окошко на завтра к Ирине Алилгаджиевне…» — это
   * просьба записать ребёнка, а не стоп-слово «окошко». Модели уходит текст
   * целиком: там цитата помогает понять, о какой услуге речь.
   */
  const own = withoutQuote(text);
  /**
   * На какую реплику отвечают свайпом. Нужна дважды: чтобы «Ок» на справку не
   * стало согласием на обработку данных и чтобы вежливость осталась
   * вежливостью (ниже).
   */
  const { quote } = splitQuote(text);
  // Дальше все ответы проходят через respond, а он добавит приветствие, если
  // человек поздоровался. Одно место на все ветки.
  ctx.incomingText = own;
  /**
   * Тело сообщения складывается из подписи пациента и пометок о вложениях.
   * Пустым оно бывает только у по-настоящему пустого update — раньше сюда же
   * попадали все голосовые и фотографии, и обращение терялось молча.
   */
  const body = messageBody(text, attachments);
  if (!body) return null;

  /**
   * Сообщение уже в переписке — повторная обработка.
   *
   * Добор неотвеченных (lib/agent/unanswered) вызывает нас на сообщении,
   * которое сохранено при первой попытке: тогда обработка или отправка
   * сорвалась, и ответа человек не получил. Сохранять второй раз нельзя —
   * упрёмся в уникальный внешний идентификатор, а в переписке появится дубль.
   */
  if (!input.alreadySaved) {
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
  }

  /**
   * Согласие на обработку ПДн — до всего остального (§7). Спрашиваем один раз
   * за диалог; пока клиника не завела текст согласия, вопрос не задаётся.
   */
  /**
   * Согласие на входе больше не спрашиваем.
   *
   * Спрашиваем его перед запросом персональных данных — этим занимается
   * respond, через который уходит любой ответ. Здесь остаётся один случай:
   * человек прислал ФИО и жалобу САМ, не дожидаясь вопроса. Обрабатывать это
   * без согласия нельзя, поэтому спрашиваем сразу.
   *
   * Вызов с `ask = false` не молчаливый: он узнаёт своего пациента и
   * переносит согласие из карточки на диалог, как раньше.
   */
  /**
   * Имена сотрудников — чтобы выбор врача не приняли за присланное ФИО.
   *
   * «Взрослый Разият Резванова» — три слова с заглавной буквы, и разбор анкеты
   * счёл это персональными данными пациента: завелась эскалация «прислал данные
   * до согласия», а человек получил юридический текст вместо подтверждения
   * выбора.
   */
  const clinicStaffNames = await staffNamesOf(ctx.companyId).catch(() => []);
  const consent = await consentRequestFor(
    ctx.companyId,
    conversation.id,
    looksLikeIntake(own, clinicStaffNames),
  );
  if (consent) {
    const alreadyWithHuman = await callHumanWhileWaitingConsent(
      ctx,
      conversation.id,
      own,
      attachments,
    );
    /**
     * Ответ на вопрос идёт вместе с запросом согласия, а не вместо него.
     *
     * Человек написал «сколько стоит приём?» и получал юридическую стену —
     * первое, что он слышит от клиники. Цена, адрес и часы работы публичны, и
     * назвать их можно, ничего не обрабатывая. Согласие при этом спрашиваем
     * тем же сообщением и без него дальше не идём.
     */
    const known = await referenceAnswer(ctx.companyId, own).catch(() => null);
    return respond(ctx, conversation.id, {
      text:
        (known
          ? `${known}\n\n${consent.text}${consentHint(ctx.channel)}`
          : consent.text + consentHint(ctx.channel)) + alreadyWithHuman,
      buttons: consent.buttons,
      platformConsent: true,
    });
  }

  /**
   * Ответ на вопрос о согласии словами.
   *
   * В WhatsApp кнопок нет, и без этой ветки согласие там нельзя было дать
   * вообще: вопрос задавался, ответить на него было нечем.
   *
   * Слова принимаем только пока согласие ждём. Вне этого «да» в переписке
   * значит что угодно, и засчитать его за согласие было бы подлогом.
   *
   * А вот СТЕНЫ здесь больше нет. Пока согласие гатило всю переписку, каждое
   * следующее сообщение упиралось в «нужно ваше согласие», и разговор был
   * заперт: пациентка писала благодарность врачу и получала форму, через три
   * недели спрашивала про окошко — и получала её же. Теперь согласие гатит
   * только запрос персональных данных (respond), а на вопросы агент отвечает
   * как обычно: спросил один раз — и ведёт разговор дальше.
   */
  if (conversation.consentAskedAt && !conversation.consentGrantedAt) {
    /**
     * «Ок» в ответ на справку — не согласие на обработку данных.
     *
     * Живой диалог: пациентка свайпом ответила «Ок» на справку о том, что
     * входит в приём. Слово «ок» стоит в списке согласий, и платформа зачла
     * его как согласие — при том что отвечали на другую реплику. Согласие
     * должно быть осознанным (§7): если в цитате не наш вопрос о согласии,
     * это ответ не нам.
     */
    const toConsentQuestion = !quote || /соглас|персональн|политик/i.test(quote);
    /**
     * «Да» на наш вопрос об окошке — тоже не согласие.
     *
     * Согласие могли спросить давно и без ответа, а сейчас агент уточнил
     * «окошко на ср, 1 октября в 12:15 — верно?». Засчитать «Да» за согласие
     * на обработку данных значило бы взять его не осознанно (§7). Последним
     * задан вопрос об окошке — значит «да» ему.
     */
    const slotAsked = conversation.consentAskedAt
      ? await prisma.slotHold
          .findFirst({
            where: { conversationId: conversation.id, state: "CHOICE", createdAt: { gt: conversation.consentAskedAt } },
            select: { id: true },
          })
          .catch(() => null)
      : null;
    const answer = toConsentQuestion && !slotAsked ? consentFromText(own) : null;
    if (answer) return handleCallback(ctx, conversation.id, answer);
  }

  /**
   * Ответ на статус с окошком и ответ на наш вопрос о нём — не вежливость.
   *
   * «Ок», «👍», «+» в ответ на «Окошко на завтра к Ирине ✅ 09:40» значат «беру»,
   * а «Хорошо» на «окошко на ср, 1 октября в 12:15 — верно?» — «да». Правило
   * молчания на вежливость (`nothingToAnswer`) судит по реплике, на которую
   * отвечают, и в статусе вопроса не находит — поэтому такие сообщения его
   * обходят.
   */
  const aboutSlot =
    looksLikeOffer(input.quote?.text) ||
    (await prisma.slotHold
      .findFirst({
        where: {
          conversationId: conversation.id,
          state: "CHOICE",
          startAt: { gt: new Date() },
          createdAt: { gt: new Date(Date.now() - 24 * 3600_000) },
        },
        select: { id: true },
      })
      .catch(() => null)) !== null;

  /**
   * На «хорошо» и «спасибо» агент не отвечает, если отвечать не на что.
   *
   * Два живых случая. Пациентка описала диагноз ребёнка, услышала «уточню у
   * врача», написала «Хорошо» — и получила «Хорошо, если появятся вопросы — я
   * здесь», хотя как раз ждала ответа врача. Другая после «Спасибо, передал(а)
   * данные администратору» обменялась с агентом тремя вежливостями подряд:
   * «Хорошо» — «Хорошо, если появятся…» — «Спасибо» — «Пожалуйста!» — «Хорошо».
   *
   * Правило про жесты вежливости (`nothingToAnswer`) было, но стояло ОДНО — в
   * доборе неотвеченных, и прямой путь его не проверял вовсе.
   *
   * Молчим только когда отвечать действительно не на что: вопрос уже у врача,
   * ИЛИ последней репликой агент ничего не спрашивал. «Хорошо» после
   * «Подтверждаете?» — это ответ, и на него агент отвечает как обычно
   * (`agentAskedSomething`). Сообщение с цитатой вежливостью не считается:
   * человек отвечает свайпом на конкретную реплику, и точка в ответ на свою
   * же анкету — это «вот мои данные», а не «спасибо».
   */
  /**
   * Цитата не превращает «Ок» в вопрос.
   *
   * Прежде любое сообщение с цитатой считалось не-вежливостью, и правило
   * молчания его не разбирало вовсе. Живой диалог: человек свайпом ответил
   * «Ок» на справку о том, что входит в приём, — и получил запись про то, что
   * взрослых мужчин на остеопатию не принимают. Ни одного повода для такого
   * ответа в переписке не было.
   *
   * Смотреть надо на ТУ реплику, на которую отвечают: если в цитате был вопрос
   * — «Ок» это ответ, и молчать нельзя; если справка без вопроса — это жест
   * вежливости, и отвечать нечего.
   */
  if (!aboutSlot && nothingToAnswer(own)) {
    const pending = await specialistQueryPending(ctx.companyId, conversation.id);
    const lastAgent = pending
      ? undefined
      : quote
        ? { content: quote }
        : [...(await recentTurns(conversation.id))].reverse().find((t) => t.role === "assistant");
    if (pending || (lastAgent && !agentAskedSomething(lastAgent.content))) {
      await logAgentRun({
        companyId: ctx.companyId,
        conversationId: conversation.id,
        outcome: "SUPPRESSED",
        error: pending
          ? "вопрос у врача, пациент ответил вежливостью — отвечать нечего"
          : "пациент ответил вежливостью, а агент ничего не спрашивал — отвечать нечего",
      });
      return null;
    }
  }

  /**
   * Пункт меню, набранный текстом. В канале без кнопок подсказки уходят
   * строками, и пациент отвечает на них словами — «цены», «адрес».
   */
  const menu = aboutSlot ? null : menuActionFromText(own);
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

  return replyToQuestion(ctx, conversation, text, input.quote ?? null);
}

/**
 * О чём разговор: вопрос для врача — вместе с предыдущими репликами пациента.
 *
 * Человек пишет ситуацию несколькими сообщениями: «у меня ДЦП» — «мне 33
 * года» — «думала просто консультация». Судить о сложности по последней
 * реплике значит не увидеть вопроса вовсе.
 */
function questionForDoctor(own: string, said: { role: string; content: string }[]): string {
  const mine = said
    .filter((t) => t.role === "user")
    .slice(-4)
    .map((t) => t.content);
  return [...mine, own].join("\n");
}

/**
 * Что мы точно знаем про названные дни: работает ли клиника и кто принимает.
 *
 * Дописывается к ответу модели, когда она про день не сказала. Факты берём из
 * базы: график клиники и дни врачей. Если график не заведён — молчим, а не
 * гадаем.
 */
async function workdayFacts(companyId: string, days: number[]): Promise<string | null> {
  const [schedule, doctors] = await Promise.all([
    prisma.clinicSchedule.findMany({
      where: { companyId },
      select: { weekday: true, startMinute: true, endMinute: true },
    }),
    prisma.staff.findMany({
      where: { companyId, isActive: true, deletedAt: null },
      orderBy: { name: "asc" },
      select: { name: true, specialty: true, workdays: true },
    }),
  ]);
  if (schedule.length === 0) return null;

  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const lines = days.map((d) => {
    const open = schedule.find((x) => x.weekday === d);
    if (!open) return `${WEEKDAY_WHEN[d]} у нас выходной`;
    const works = whoWorks(doctors, [d]).works;
    const who = works.length
      ? ` Принимают: ${works.map((w) => `${w.name}${w.specialty ? ` — ${w.specialty}` : ""}`).join("; ")}.`
      : "";
    return `${WEEKDAY_WHEN[d]} работаем с ${hhmm(open.startMinute)} до ${hhmm(open.endMinute)}.${who}`;
  });
  const text = lines.join(" ");
  return `${text[0].toUpperCase()}${text.slice(1)}`;
}

/**
 * Имена тех, кто ведёт услугу, — по состоявшимся визитам.
 *
 * Нужно справке: агент не должен спрашивать «к какому специалисту», когда
 * специалист один. Берём из визитов, а не из настройки: справочник знает это
 * сам и не расходится с действительностью.
 */
/**
 * Услуги врача, которого назвал пациент, — по визитам, как и всё «кто что ведёт».
 *
 * Живой диалог 1 октября: «как записаться на приём к Ирине Алункачевой» →
 * «Малышу 2 месяца» → «В какую стоимость консультация» — и агент назвал
 * «Консультация — 1000 ₽», чужую позицию прайса. У Ирины Алилгаджиевны
 * отдельной консультации нет, детский приём стоит 5000 ₽; администратору
 * пришлось извиняться за бота. Подбор смотрел на одну последнюю реплику, а
 * врача и возраст человек назвал раньше. Когда врач назван, общий вопрос о
 * цене — про ЕГО приём.
 */
type ServiceRow = Awaited<ReturnType<typeof getServices>>[number];

interface TalkChoice {
  /** Врач, названный пациентом, — однозначно или через названную услугу. */
  doctor: { id: string; name: string } | null;
  /** Ровно одна строка прайса, если выбор однозначен. */
  service: ServiceRow | null;
  /** Строки, подходящие под сказанное (несколько — значит выбор не сделан). */
  candidates: ServiceRow[];
  whom: Whom;
}

/**
 * Что человек выбрал за разговор: врача, услугу, для кого. ОДНА функция на все
 * места, где код сам отвечает на шаг записи, — иначе цена в одном сообщении и
 * врач в другом расходятся, как в живом диалоге 4 октября: «к Ирине А.» →
 * «остеопат» → «Остеопатия, прием Разият — 5000 ₽».
 *
 * Правила простые и все — про то, чтобы не угадывать:
 *   • врач назван однозначно (с фамилией, отчеством или инициалом) — берём его
 *     строки прайса и выбираем под возраст;
 *   • имя названо, но тёзок двое («к Ирине»), а услуга известна — врач тот,
 *     кто её ведёт («Ирина» + «остеопат» — это остеопат, а не БОС-терапевт);
 *   • подходят строки разных врачей, а врача человек не называл — услуга НЕ
 *     выбрана: спрашиваем врача и называем цены обоих, а не самую дешёвую.
 */
async function talkChoice(companyId: string, newest: string[]): Promise<TalkChoice> {
  const [services, staff] = await Promise.all([
    getServices(companyId).catch(() => [] as ServiceRow[]),
    prisma.staff
      .findMany({ where: { companyId, isActive: true, deletedAt: null }, select: { id: true, name: true } })
      .catch(() => [] as { id: string; name: string }[]),
  ]);
  const whom = whomAcross(newest);
  const pregnancy = newest.some((t) => /беремен/iu.test(t));
  const usable = patientServices(services).filter((s) => pregnancy || !/беремен/iu.test(s.title));

  /** Чьи строки: имя в названии решает, иначе — кто по ним принимал. */
  const doctorsOf = async (row: ServiceRow): Promise<Set<string>> => {
    const titled = namedInTitle(row.title, staff);
    if (titled.length > 0) return new Set(titled.map((x) => x.id));
    const visits = await prisma.appointment
      .groupBy({ by: ["staffId"], where: { companyId, deletedAt: null, services: { some: { serviceId: row.id } } } })
      .catch(() => []);
    return new Set(visits.map((v) => v.staffId));
  };

  const named = dedupeServices(
    newest
      .map((t) => matchServices(serviceQuery(t), usable, 6, 0.5, whom))
      .find((found) => found.length > 0) ?? [],
  );

  let doctor = newest.map((t) => uniqueStaffAsked(t, staff)).find((x) => x !== null) ?? null;

  if (doctor) {
    // Строки этого врача: по визитам и по имени в названии, без чужих именных.
    const visited = await prisma.appointmentService
      .groupBy({ by: ["serviceId"], where: { companyId, appointment: { staffId: doctor.id, deletedAt: null } } })
      .catch(() => []);
    const ids = new Set(visited.map((v) => v.serviceId));
    const own = usable.filter((row) => {
      const titled = namedInTitle(row.title, staff);
      if (titled.length > 0) return titled.some((x) => x.id === doctor!.id);
      return ids.has(row.id);
    });
    const ownNamed = named.length > 0 ? own.filter((row) => named.some((n) => n.id === row.id)) : own;
    const pool = dedupeServices(forAge(ownNamed.length > 0 ? ownNamed : own, whom));
    return { doctor, service: pool.length === 1 ? pool[0] : null, candidates: pool, whom };
  }

  let candidates = named;
  const mentioned = staff.filter((x) => newest.some((t) => mentionsStaff(t, x.name)));
  if (mentioned.length > 0 && candidates.length > 0) {
    const tagged = await Promise.all(candidates.map(async (row) => ({ row, by: await doctorsOf(row) })));
    const theirs = tagged.filter((x) => mentioned.some((m) => x.by.has(m.id)));
    if (theirs.length > 0) {
      candidates = theirs.map((x) => x.row);
      const who = new Set(theirs.flatMap((x) => mentioned.filter((m) => x.by.has(m.id)).map((m) => m.id)));
      if (who.size === 1) doctor = mentioned.find((m) => who.has(m.id)) ?? null;
    }
  }
  return { doctor, service: candidates.length === 1 ? candidates[0] : null, candidates, whom };
}

/** «Алункачева Ирина Алилгаджиевна» → «Ирина Алилгаджиевна»: так к врачу обращаются пациенты. */
function shortName(full: string): string {
  const parts = full.trim().split(/\s+/);
  return parts.length >= 3 ? parts.slice(1).join(" ") : full.trim();
}

/** Выбор одной строкой — только факты из прайса. */
function choiceLine(c: TalkChoice): string | null {
  const dur = c.service && c.service.durationMin > 0 ? `, ${c.service.durationMin} мин` : "";
  if (c.service && c.doctor) return `${shortName(c.doctor.name)}: ${c.service.title} — ${c.service.price} ₽${dur}.`;
  if (c.service) return `${c.service.title} — ${c.service.price} ₽${dur}.`;
  const kind = c.whom === "child" ? "детский приём" : c.whom === "adult" ? "взрослый приём" : null;
  if (c.doctor) return kind ? `${shortName(c.doctor.name)}, ${kind}.` : `${shortName(c.doctor.name)}.`;
  return kind ? `${kind[0].toUpperCase()}${kind.slice(1)}.` : null;
}

/** Услуги названного врача под возраст — для справки модели. */
async function doctorOffer(
  companyId: string,
  patientTextsNewestFirst: string[],
): Promise<{ doctor: string; services: ServiceRow[] } | null> {
  const choice = await talkChoice(companyId, patientTextsNewestFirst);
  if (!choice.doctor || choice.candidates.length === 0) return null;
  return { doctor: choice.doctor.name, services: choice.candidates };
}

/** Услуги под возраст: «детский» в названии — для ребёнка, остальные — для взрослого. */
function forAge<T extends { title: string }>(services: T[], whom: Whom): T[] {
  if (whom === "unknown") return services;
  const child = (t: string) => /(?<!\p{L})(дет[си]|ребен|ребён|подрост)/iu.test(t.toLowerCase());
  return services.filter((s) => (whom === "child" ? child(s.title) : !child(s.title)));
}

/** Основа слова имени: «Ирина» должна найтись и в «Ирине», «Ириной». */
function nameStem(word: string): string {
  return word.slice(0, Math.min(5, word.length - 1));
}

/** Упомянут ли сотрудник в тексте хотя бы одним словом имени. */
function mentionsStaff(text: string, name: string): boolean {
  const t = text.toLowerCase().replace(/ё/g, "е");
  return name
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/\s+/)
    .filter((w) => w.length >= 4)
    .some((w) => new RegExp(`(?<!\\p{L})${nameStem(w)}`, "u").test(t));
}

/**
 * Чья строка прайса — по названию.
 *
 * На боевом прайсе у врачей СВОИ строки: «Остеопатия, прием Разият — 5000 ₽»
 * рядом со «Взрослый прием - остеопатия — 8000 ₽». Живой диалог 4 октября:
 * человек просился к Ирине, а код взял самую дешёвую строку про остеопатию — и
 * назвал цену приёма Разият. Имя в названии строки — самый надёжный признак,
 * чья она: визиты бывают записаны куда попало, название пишет клиника.
 */
function namedInTitle<T extends { id: string; name: string }>(title: string, staff: T[]): T[] {
  return staff.filter((s) => mentionsStaff(title, s.name));
}

async function staffNamesForService(companyId: string, serviceId: string): Promise<string[]> {
  const [service, everyone] = await Promise.all([
    prisma.service.findUnique({ where: { id: serviceId }, select: { title: true } }).catch(() => null),
    prisma.staff
      .findMany({ where: { companyId, isActive: true, deletedAt: null }, select: { id: true, name: true } })
      .catch(() => []),
  ]);
  const titled = service ? namedInTitle(service.title, everyone) : [];
  if (titled.length === 1) return [titled[0].name];
  const rows = await prisma.appointment.groupBy({
    by: ["staffId"],
    where: { companyId, deletedAt: null, services: { some: { serviceId } } },
    _count: { _all: true },
    orderBy: { _count: { staffId: "desc" } },
    take: 3,
  });
  if (rows.length === 0) return [];
  const staff = await prisma.staff.findMany({
    where: { id: { in: rows.map((r) => r.staffId) }, isActive: true, deletedAt: null },
    select: { id: true, name: true },
  });
  return rows.map((r) => staff.find((x) => x.id === r.staffId)?.name).filter((n): n is string => Boolean(n));
}

/**
 * Кто ведёт эту услугу — по состоявшимся визитам.
 *
 * Справочник знает это сам и точнее любой настройки: «в субботу есть
 * БОС-терапия?» — вопрос про того, кто её проводит, а не про остеопатов.
 */
async function staffForService(companyId: string, serviceId: string): Promise<string[]> {
  const rows = await prisma.appointment.groupBy({
    by: ["staffId"],
    where: { companyId, deletedAt: null, services: { some: { serviceId } } },
    _count: { _all: true },
    orderBy: { _count: { staffId: "desc" } },
    take: 5,
  });
  return rows.map((r) => r.staffId);
}

/**
 * Какая услуга обсуждается — чтобы вопрос ушёл тому, кто её ведёт.
 *
 * Вопрос про БОС-терапию не должен идти остеопату: кто что ведёт, знает
 * справочник визитов, и настройке это дублировать незачем.
 */
async function serviceInTalk(
  companyId: string,
  own: string,
  said: { role: string; content: string }[],
): Promise<string | null> {
  const query = searchText(
    own,
    said.filter((t) => t.role === "user").map((t) => t.content),
  );
  const found = matchServices(query, await getServices(companyId).catch(() => []), 1, 0.5);
  return found[0]?.id ?? null;
}

/**
 * Короткий ответ из справки — без модели и без эскалации.
 *
 * Нужен там, где отвечать полноценно ещё нельзя: пациент только написал, и мы
 * просим у него согласие на обработку данных (§7). Прежде вместе с запросом
 * согласия уходила ТОЛЬКО юридическая стена: человек спрашивал «сколько стоит
 * приём?», а получал форму. Второй такой вопрос — ту же форму, третий — «передал
 * администратору». За три реплики новый пациент не услышал ни одной цены.
 *
 * Часы работы, адрес и прайс — сведения публичные: чтобы их назвать, ничьи
 * персональные данные обрабатывать не нужно. Согласие мы при этом всё равно
 * просим и без него дальше переписку не ведём.
 *
 * Модель здесь не спрашиваем намеренно: до согласия в неё не уходит ничего.
 */
async function referenceAnswer(companyId: string, text: string): Promise<string | null> {
  if (text.trim().length < 4) return null;

  /**
   * Прайс спрашиваем ПЕРВЫМ.
   *
   * Справочник отвечает по пересечению слов, и «Сколько стоит приём?» уверенно
   * находило запись «Часы работы» — там в вопросе стоит «часы приёма». Человек
   * спросил цену, а услышал график. У услуги совпадение точнее: она называется
   * ровно тем словом, которое он написал.
   */
  const services = await getServices(companyId).catch(() => []);
  /**
   * «Сколько стоит приём?» — вопрос про цену, и порог совпадения здесь ниже.
   *
   * Доля считается от всех значимых слов вопроса, а их три: «сколько»,
   * «стоит», «приём». В название услуги попадает одно, доля выходит 0,33 — и
   * прямой вопрос о цене не находил ни одной услуги, зато справочник уверенно
   * отвечал графиком работы: там в вопросе записано «часы приёма».
   *
   * Не нашли конкретную услугу — показываем прайс: человек спросил цену, и
   * список цен ему полезнее, чем режим работы.
   */
  const priced = dedupeServices(matchServices(text, services, 3, 0.5));
  if (priced.length > 0) {
    return priced
      .map((p) => `${p.title} — ${p.price} ₽${p.durationMin > 0 ? `, ${p.durationMin} мин` : ""}`)
      .join("\n");
  }
  /**
   * Не нашли услугу — молчим, а не выкладываем прайс целиком.
   *
   * Здесь стоял запасной ход «спросили про цену, покажем всё». На вопрос
   * «Здравствуйте сколько стоит остеопатия?» новый пациент получил двадцать
   * пять строк прайса подряд — от забора крови до инфузий, — и следом стену
   * согласия. Прямой вопрос, вместо ответа простыня: так теряют человека с первого
   * сообщения. Лучше не сказать ничего, чем сказать всё сразу.
   */

  const rows = await prisma.knowledgeEntry.findMany({
    where: usableKnowledgeWhere(companyId),
    select: { id: true, topic: true, question: true, answer: true },
  });
  const match = matchKnowledge(text, rows);
  if (confidentMatch(match)) return match!.row.answer.trim();
  return null;
}

/**
 * Что просим прислать, когда запись только начинается.
 *
 * Заказчик просил прямо: «он бы просто оформил клиента как нужно». Данные
 * администратору всё равно понадобятся, и спросить их лучше сейчас, пока
 * человек в переписке, чем заставлять его отвечать на те же вопросы завтра.
 */
/**
 * Для кого приём — по словам пациента во ВСЁМ разговоре, а не в одной реплике.
 *
 * Прежде здесь стоял `searchText`, а он приклеивает прошлые реплики только к
 * обрывку. Живой диалог 1 октября: «Малышу 2 месяца» → «В какую стоимость
 * консультация» → «Да» — последний вопрос законченный, прошлое к нему не
 * приклеилось, и после согласия ушла ВЗРОСЛАЯ анкета: без имени родителя и
 * без веса, хотя речь шла о двухмесячном ребёнке.
 */
function whomInTalk(own: string, said: { role: string; content: string }[]): Whom {
  return talkWhom([own, ...said.filter((t) => t.role === "user").map((t) => t.content)]);
}

/** То же по готовому списку: текущая реплика, затем прошлые по порядку. */
function talkWhom(patientTexts: string[]): Whom {
  return whomAcross([patientTexts[0] ?? "", ...patientTexts.slice(1).reverse()]);
}

/**
 * Нужен ли вес: он спрашивается только там, где действительно нужен.
 *
 * Заказчик назвал этот случай прямо — остеопатия. Спрашивать вес у всех
 * подряд его инструкция запрещает: «Не запрашивай вес автоматически для всех
 * пациентов».
 */
async function osteopathyInTalk(
  companyId: string,
  own: string,
  said: { role: string; content: string }[],
): Promise<boolean> {
  return osteopathyInTexts(companyId, [own, ...said.filter((t) => t.role === "user").map((t) => t.content)]);
}

/**
 * Остеопатия ли — по всему разговору и по названному врачу.
 *
 * Смотрело только последнюю реплику (`searchText` приклеивает прошлое лишь к
 * обрывку). Живой диалог 1 октября: «к Ирине Алункачевой» → «Малышу 2 месяца»
 * → «В какую стоимость консультация» → «Да» — и анкета ушла без веса, хотя
 * клиника на остеопатии его требует: в последней реплике слова «остеопат» нет.
 */
async function osteopathyInTexts(companyId: string, patientTexts: string[]): Promise<boolean> {
  const texts = patientTexts.map((t) => withoutQuote(t));
  if (texts.some((t) => /остеопат/i.test(t))) return true;
  const services = await getServices(companyId).catch(() => []);
  const named = texts.map((t) => matchServices(serviceQuery(t), services, 1, 0.5)[0]);
  if (named.some((s) => /остеопат/i.test(s?.title ?? ""))) return true;
  const newestFirst = [texts[0] ?? "", ...texts.slice(1).reverse()];
  const offer = await doctorOffer(companyId, newestFirst).catch(() => null);
  return offer ? forAge(offer.services, whomAcross(newestFirst)).some((s) => /остеопат/i.test(s.title)) : false;
}

/**
 * Что дописать к ответу модели на шаге записи: цены и ОДИН вопрос.
 *
 * Раньше это были три независимые дописки (цены, выбор врача, просьба о
 * данных), и каждая проверяла свои условия. Они спорили: «взрослый или
 * ребёнок?» приходил с одними взрослыми ценами, выбор врача исчезал, если
 * модель обещала передать администратору, а согласие вставало на шаге выбора.
 * Порядок теперь решает одна функция (`bookingStep`), а здесь только факты из
 * базы и текст.
 */
async function bookingTail(
  companyId: string,
  input: {
    /** Ответ модели — по нему видно, о чём она уже спросила. */
    answer: string;
    /** Слова пациента за разговор, свежие первыми. */
    patientTexts: string[];
    booking: boolean;
    dataDone: boolean;
    refused: boolean;
    /** Для кого приём, если это уже сказано. */
    whom: Whom;
  },
): Promise<{ text: string; step: BookingStep | null }> {
  const services = await getServices(companyId).catch(() => []);

  /**
   * Врач — тем же правилом, что и строка выбора (`talkChoice`): «к Ирине А.» и
   * «к Ирине» + «остеопат» — это врач названный, а не повод спросить заново.
   */
  const newestFirst = [input.patientTexts[0] ?? "", ...input.patientTexts.slice(1).reverse()];
  const choice = await talkChoice(companyId, newestFirst).catch(() => null);
  const doctorNamed = choice?.doctor?.name ?? null;

  /**
   * Агент СПРОСИЛ, для кого приём, — значит наша догадка не в счёт.
   *
   * «К остеопату записаться можно?» даёт «взрослый» из возвратного глагола, и
   * шаг возраста считался пройденным: рядом с вопросом модели «это взрослый
   * приём или для ребёнка?» стояла одна взрослая цена. Пациент при этом ничего
   * не говорил — отвечать ему нечем, кроме обеих цен.
   */
  const whom: Whom = asksWhom(input.answer) ? "unknown" : input.whom;

  /**
   * Услуга: ищем в КАЖДОЙ реплике пациента отдельно — склеенный разговор
   * разбавляет название до нуля. Возраст в подбор не пускаем, пока он не
   * назван: иначе догадка «взрослый» скрывает детские цены.
   */
  const anyAge = dedupeServices(
    patientServices(
      input.patientTexts
        // «Приём» услугу не называет — как и в `knownService` (GENERIC_SERVICE_WORDS).
        .map((t) => matchServices(serviceQuery(t), services, 4, 0.5, "unknown"))
        .find((found) => found.length > 0) ?? [],
    ),
  );
  const forWhom =
    whom === "unknown"
      ? anyAge
      : dedupeServices(
          patientServices(
            input.patientTexts
              .map((t) => matchServices(serviceQuery(t), services, 4, 0.5, whom))
              .find((found) => found.length > 0) ?? [],
          ),
        );

  /**
   * Возраст важен только там, где у услуги есть оба варианта: детский приём и
   * взрослый. Вариант один — спрашивать нечего, цена от ответа не изменится.
   */
  const childish = (title: string) => /(?<!\p{L})(дет[си]|ребен|ребён|подрост)/iu.test(title.toLowerCase());
  const whomMatters = anyAge.some((s) => childish(s.title)) && anyAge.some((s) => !childish(s.title));

  /** Кто ведёт подходящие услуги — по имени в строке прайса и по визитам. */
  const providers = new Set<string>();
  for (const s of forWhom.length > 0 ? forWhom : anyAge) {
    for (const name of await staffNamesForService(companyId, s.id).catch(() => [])) providers.add(name);
  }
  /**
   * Врач выбран — цены называем только его. Иначе на шаге данных рядом с
   * выбором Ирины стояла бы и цена Разият.
   */
  const doctorRows = choice?.doctor ? choice.candidates : [];

  const askedByModel = {
    service: asksService(input.answer),
    whom: asksWhom(input.answer),
    doctor: asksDoctor(input.answer),
    data: asksForIntake(input.answer) || asksForPersonalData(input.answer),
  };
  const { step, ask } = bookingStep({
    booking: input.booking,
    service: anyAge.length > 0 || doctorNamed !== null,
    whom: whom !== "unknown",
    whomMatters,
    doctorMatters: providers.size >= 2,
    doctor: doctorNamed !== null,
    dataDone: input.dataDone,
    refused: input.refused,
    askedByModel,
  });
  if (!step) return { text: input.answer, step: null };

  /**
   * Модель спросила СВОЁ — ничего не дописываем.
   *
   * Правило об одном вопросе срезало бы наш вопрос, а цены шага оставались бы
   * рядом с чужим вопросом: «вы хотите записаться сами или записываете
   * ребёнка?» и под ним одна взрослая цена. Если модель спрашивает не про этот
   * шаг, разговор ведёт она — молчим и не мешаем.
   */
  if (/\?/.test(input.answer) && !askedByModel[step]) {
    return { text: input.answer, step };
  }

  /**
   * Цены — ровно те, что относятся к шагу: на вопросе о возрасте обе, на выборе
   * врача те, что подходят названному возрасту. Цена, уже названная моделью,
   * второй раз не печатается.
   */
  const shown =
    step === "whom"
      ? doctorRows.length > 0
        ? doctorRows
        : anyAge
      : step === "doctor"
        ? forWhom.length > 0
          ? forWhom
          : anyAge
        : [];
  /**
   * На выборе врача — цены КАЖДОГО, кого модель не назвала. Она писала «детский
   * приём 5000 ₽, проводит Ирина Алилгаджиевна» и тут же «к кому хотите — к
   * Разият или к Ирине?»: цену второго врача человек так и не видел, а выбирать
   * должен с ценами обоих (порядок клиники).
   */
  const mentioned = (price: number) => {
    const plain = String(price);
    const spaced = plain.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    return [plain, spaced, spaced.replace(/ /g, "\u00a0")].some((p) => input.answer.includes(p));
  };
  const prices =
    shown.length === 0
      ? ""
      : step === "doctor"
        ? shown
            .filter((r) => !mentioned(r.price))
            .map(priceLine)
            .join("\n")
        : hasPrice(input.answer)
          ? ""
          : shown.map(priceLine).join("\n");

  const names = [...providers];
  // Вес — только на остеопатии, по требованию клиники (как и в `intakeAsk`).
  const weight =
    step === "data" && ask && (await osteopathyInTexts(companyId, input.patientTexts).catch(() => false)) ? ", вес" : "";
  const question = !ask
    ? ""
    : step === "service"
      ? "Подскажите, пожалуйста, на какую услугу записываемся?"
      : step === "whom"
        ? "Приём для взрослого или для ребёнка?"
        : step === "doctor"
          ? `К кому хотите записаться — ${names.slice(0, -1).join(", ")} или ${names[names.length - 1]}?`
          : `Чтобы администратору не спрашивать заново — пришлите, пожалуйста, одним сообщением: ${
              whom === "child"
                ? `ФИО ребёнка, его возраст${weight}, имя родителя и кратко причину обращения`
                : `ФИО того, кто придёт на приём, возраст${weight} и кратко причину обращения`
            }.`;

  return { text: [input.answer, prices, question].filter(Boolean).join("\n\n"), step };
}

/**
 * Цена в тексте уже названа.
 *
 * Не только знаком «₽»: модель пишет и «5000 рублей», и «5 000 руб.». Проверка
 * по одному знаку пропускала это, и к ответу дописывалась та же цена цифрой —
 * в одном сообщении дважды.
 */
function hasPrice(text: string): boolean {
  return /₽|руб(?:\.|л\p{L}*)?(?!\p{L})/iu.test(text);
}

function intakeAsk(whom: Whom, needsWeight = false): string {
  /**
   * Ребёнка записывают на имя родителя.
   *
   * «Имя ребёнка, его возраст и кратко причина» — этого администратору мало:
   * договариваться о времени и звонить он будет родителю, и в записи нужен
   * тот, кто приведёт. Спрашиваем обоих сразу, одним сообщением, — иначе
   * получается второй заход за тем же.
   */
  const weight = needsWeight ? ", вес" : "";
  const who =
    whom === "child"
      ? `ФИО ребёнка, его возраст${weight}, имя родителя и кратко причину обращения`
      : `ФИО, возраст${weight} и кратко причину обращения`;
  /**
   * «Передал(а) вашу просьбу» здесь неправда: человек только что ответил
   * «Да» на согласие и ни о чём администратора не просил. Ему ещё предстоит
   * прислать данные — с них и начинается работа администратора.
   */
  return `Спасибо! Время подберёт администратор — он напишет здесь же. Чтобы не терять время, пришлите, пожалуйста, одним сообщением: ${who}.`;
}

/**
 * Названа ли уже услуга — в этом сообщении или раньше в разговоре.
 *
 * Нужно, чтобы не переспрашивать то, что человек уже сказал: переспрос
 * читается как «вас не слушали» и обрывает разговор вернее отказа.
 *
 * Порог совпадения выше нуля намеренно: «Доброго дня» иначе находило услугу
 * по одному общему слову, и агент считал, что услуга уже выбрана.
 */
/**
 * Что ответить, когда время подбирает человек.
 *
 * Одна функция на обе ветки — обычную и стоп-словную. Тексты, разошедшиеся
 * между ними, означали бы, что по одному и тому же вопросу пациент слышит
 * разное в зависимости от того, попало ли в его сообщение стоп-слово.
 *
 * Спрашиваем только неизвестное: услуга, названная в этом же сообщении или
 * раньше, переспроса не требует. И ОДИН вопрос, а не анкету — два подряд
 * человек воспринимает как форму и бросает. ФИО и возраст здесь не просим
 * никогда: это персональные данные, их собирают после согласия (§7).
 */
/**
 * Следующий шаг записи — кодом, без модели: строка выбора из прайса и то, что
 * дальше по порядку (`bookingTail`: врач, данные; согласие ставит `respond`).
 *
 * Живой диалог 1 октября: мама назвала врача, следом «Малышу 2 месяца» — и
 * модель ответила «К сожалению… нужно уточнить, сможет ли Ирина принять
 * малыша», хотя справка клиники принимает детей с первого месяца, а цены
 * человек так и не услышал. Здесь отвечать нечего, кроме фактов прайса, и
 * модель для этого не нужна.
 *
 * undefined — фактов нет (врач и услуга не опознаны), пусть отвечает модель.
 */
async function bookingByCode(
  ctx: AgentContext,
  conversationId: string,
  own: string,
  said: Turn[],
  lead = "",
  /**
   * Человек отвечает на НАШ вопрос шага записи («к кому хотите?» → «к Ирине») —
   * значит запись идёт, что бы ни лежало в истории. Строка без цены тоже
   * годится: цены шага допишет `bookingTail`.
   */
  stepAnswer = false,
): Promise<AgentReply | null | undefined> {
  const choice = await conversationChoice(ctx.companyId, conversationId).catch(() => null);
  /**
   * Строку из прайса ставим, только когда выбрана услуга, — с ценой. Голое
   * «взрослый приём.» в ответ на «взрослый» (живой диалог 4 октября) читается
   * как сбой: человеку повторили его же слово с точкой.
   */
  const priced = choice?.service ? choiceLine(choice) : null;
  if (!stepAnswer && !lead && !priced) return undefined;
  const patientTexts = [own, ...said.filter((t) => t.role === "user").map((t) => withoutQuote(t.content))];
  const booking = stepAnswer || (await bookingRequestOpen(conversationId, own).catch(() => false));
  const said_ = whomFor(own);
  // «Сколько стоит приём у Ирины?» — вопрос, а не ответ: «Хорошо.» к нему не идёт.
  const asking = /(?<!\p{L})(?:сколько|когда|где|как|почему|есть\s+ли|можно\s+ли)(?!\p{L})/iu.test(own);
  const ack = !stepAnswer || asking
    ? ""
    : said_ === "child"
      ? "Хорошо, приём для ребёнка."
      : said_ === "adult"
        ? "Хорошо, приём для взрослого."
        : "Хорошо.";
  const template = [ack, priced].filter(Boolean).join(" ");
  const phrased =
    template && (choice?.doctor || choice?.service)
      ? await phraseStep(ctx, conversationId, choice, talkWhom(patientTexts), own, said).catch(() => null)
      : null;
  const answer = [lead, phrased ?? template].filter(Boolean).join(" ");
  const tail = await bookingTail(ctx.companyId, {
    answer,
    patientTexts,
    booking,
    /**
     * Ответ на шаг записи — значит данных ещё нет, даже если мы их уже
     * просили: «к Ирине А.» после просьбы о данных — это поправка врача, и
     * просьбу надо повторить, а не молча закончить разговор ценой.
     */
    dataDone: stepAnswer ? false : inIntakeFlow(said),
    refused: false,
    whom: talkWhom(patientTexts),
  }).catch(() => ({ text: answer, step: null as BookingStep | null }));
  return respond(ctx, conversationId, { text: tail.text, buttons: mainMenu(), bookingContext: booking || undefined });
}

/**
 * Живое подтверждение шага записи (lib/agent/phrasing): что сказать, решил код
 * (`talkChoice`), как сказать — пишет модель. Каждое число и каждый врач в её
 * тексте сверяются с фактами; не прошло или модель молчит — null, и уходит
 * шаблон. Выключается `AGENT_PHRASE_STEPS=0`.
 */
async function phraseStep(
  ctx: AgentContext,
  conversationId: string,
  choice: TalkChoice,
  whom: Whom,
  own: string,
  said: Turn[],
): Promise<string | null> {
  if (process.env.AGENT_PHRASE_STEPS === "0") return null;
  const facts: StepFacts = {
    doctor: choice.doctor ? shortName(choice.doctor.name) : null,
    service: choice.service
      ? { title: choice.service.title, price: choice.service.price, durationMin: choice.service.durationMin }
      : null,
    whom,
    patientMessage: own,
  };
  const [staffNames, patientName] = await Promise.all([
    staffNamesOf(ctx.companyId).catch(() => [] as string[]),
    addressNameFor(conversationId).catch(() => null),
  ]);
  const text = await phraseConfirmation({
    facts: factsBlock(facts),
    patientMessage: own,
    history: said,
    patientName,
  });
  if (!text) return null;
  const problem = confirmationProblem(text, facts, staffNames);
  if (problem) {
    // Причина без текста: в нём бывают имя и жалоба (§7).
    console.warn(`[agent] подтверждение шага не прошло проверку: ${problem.replace(/:.*/, "")}`);
    if (process.env.AGENT_DRILL === "1") console.warn(`  текст: ${text}`);
    return null;
  }
  return text;
}

async function slotHandoverText(
  companyId: string,
  /**
   * Только слова пациента. Врача, услугу и «для кого» ищем в них, а не во всём
   * разговоре: наше же приветствие «Клиника доктора Алункачевой» совпало бы с
   * фамилией врача в каждой переписке, а собственный вопрос «на какую услугу
   * хотите записать ребёнка» — с названием услуги. Из-за этого агент считал
   * услугу названной и на «как попасть на приём» отвечал одной фразой, не
   * спросив главного.
   */
  patientTexts: string[],
  /**
   * Первая фраза. У вопроса про окно она про свободное время, у вопроса «как
   * попасть на приём» — про запись: отвечать про окна там, где спросили про
   * порядок записи, значит отвечать не на тот вопрос.
   */
  lead = "Свободное время подберёт администратор — он напишет здесь же.",
): Promise<string> {
  const tail = " Передам вместе с вашим вопросом, чтобы вам не повторяться.";

  /**
   * Названный врач — тоже ответ на «на какую услугу»: к кому человек идёт, он
   * сказал сам, а что она ведёт, администратор знает. Только если врач назван
   * однозначно (`uniqueStaffAsked`).
   */
  const staff = await prisma.staff
    .findMany({
      where: { companyId, isActive: true, deletedAt: null },
      select: { id: true, name: true },
    })
    .catch(() => []);
  const hasService =
    patientTexts.some((t) => uniqueStaffAsked(t, staff) !== null) ||
    (await knownService(companyId, patientTexts));
  /**
   * Взрослый или ребёнок — по всему разговору, а не по последней реплике.
   * Человек назвал это в первом сообщении, а спросил про окно во втором.
   */
  const whom = talkWhom(patientTexts);
  const hasWhom = whom !== "unknown";

  /**
   * Спрашиваем РОВНО то, чего не знаем.
   *
   * Живой диалог: «Хотела бы узнать есть окошко к остеопату Ирине?» — и в
   * ответ «на какую услугу записываемся и для кого». Услугу человек назвал
   * прямо, и переспрос читается как «вас не слушали». Возраст он при этом не
   * называл, и вот его спросить нужно — но одним вопросом, а не анкетой.
   */
  if (hasService && hasWhom) return lead;
  if (hasService) {
    return `${lead} Пока скажите, пожалуйста, приём для взрослого или для ребёнка?${tail}`;
  }
  if (hasWhom) {
    return `${lead} Пока скажите, пожалуйста, на какую услугу записываемся?${tail}`;
  }
  return (
    `${lead} Пока скажите, пожалуйста, на какую услугу записываемся и для кого — ` +
    `взрослому или ребёнку.${tail}`
  );
}

/**
 * Слова, которые есть в названии почти любой услуги.
 *
 * «Как можно попасть на приём?» — услуга не названа, а совпадение по слову
 * «приём» находилось, и агент считал её известной: на главный вопрос уходила
 * одна фраза «записывает администратор», без «на какую услугу». Убираем эти
 * слова перед подбором — тогда «на остеопатию» находится, а «на приём» нет.
 */
const GENERIC_SERVICE_WORDS =
  /(?<!\p{L})(?:приём\p{L}*|прием\p{L}*|консультаци\p{L}*|услуг\p{L}*|попасть|записаться)(?!\p{L})/giu;

/**
 * «Взрослый», «детский», «ребёнку» — это для кого, а не какая услуга.
 *
 * Прогон 4 октября: «Хотела бы записаться к остеопату» → «Взрослому» — и код
 * нашёл по слову «взрослому» строку «Взрослый прием - остеопатия», то есть
 * приём Ирины Алилгаджиевны, хотя взрослых принимают оба остеопата и выбрать
 * врача человек не успел. Для кого приём, узнаёт `whomAcross`; в подбор услуги
 * эти слова не идут.
 */
const AGE_ONLY_WORDS =
  /(?<!\p{L})(?:взросл\p{L}*|детск\p{L}*|дети|детей|детям|ребен\p{L}*|ребён\p{L}*)(?!\p{L})/giu;

/** Слова пациента для подбора услуги: без общих слов и без «для кого». */
function serviceQuery(text: string): string {
  return text.replace(GENERIC_SERVICE_WORDS, " ").replace(AGE_ONLY_WORDS, " ");
}

async function knownService(companyId: string, texts: string[]): Promise<boolean> {
  const services = await getServices(companyId).catch(() => []);
  if (services.length === 0) return false;
  return texts.some((raw) => {
    const t = serviceQuery(raw).trim();
    return t.length > 0 && matchServices(t, services, 1, 0.5).length > 0;
  });
}

// ─────────────────────────────────────────────── окошко из статуса

/**
 * Окошко занято или прошло — время подберёт администратор (решение заказчика,
 * сентябрь 2026). Своего времени агент не называет: графика смен у нас нет, и
 * «свободно в 15:00» по базе может оказаться часом, когда врач не работает.
 */
const SLOT_ELSEWHERE = "Можем предложить другое время — передал(а) администратору, он подберёт и напишет здесь же.";

/** Какие данные нужны, чтобы закрепить окошко: ребёнка записывают на имя родителя. */
function slotDataFields(child: boolean, needsWeight: boolean): string {
  const weight = needsWeight ? ", вес" : "";
  return child
    ? `ФИО ребёнка, его возраст${weight}, имя родителя и кратко причину обращения`
    : `ФИО, возраст${weight} и кратко причину обращения`;
}

/** Строка цены — только когда услуга окошка определилась однозначно. */
function slotPriceLine(service: SlotService | null): string {
  if (!service) return "";
  const duration = service.durationMin > 0 ? `, ${service.durationMin} мин` : "";
  return ` ${service.title} — ${service.price} ₽${duration}.`;
}

interface SlotStaffRow {
  id: string;
  name: string;
  specialty: string | null;
}

/**
 * Ответ на статус с окошком — или ответ на наш вопрос о нём.
 *
 * undefined — это не про окошко, разговор идёт обычным путём. Вызывается до
 * стоп-слов: у клиники в них стоит «окошко», но здесь это слово в статусе
 * самой клиники, и заказчик прямо просил, чтобы на такие ответы агент
 * отвечал, а не отделывался «передал администратору» (сентябрь 2026).
 */
async function statusSlotReply(
  ctx: AgentContext,
  conversation: { id: string; patientId: string | null },
  own: string,
  quote: AgentQuote | null,
): Promise<AgentReply | null | undefined> {
  const now = new Date();
  /**
   * Свайпом отвечают и на НАШИ реплики: «Какое время вам удобнее — 10:00,
   * 10:50 или 13:00?» → «13:00». Такая цитата — не новый статус: в нашем
   * вопросе нет «на завтра» из статуса, и день пришлось бы переспрашивать
   * заново. Узнаём её по совпадению с тем, что агент сам отправил в этой
   * переписке, — общие слова для этого не годятся, они бывают и у клиники.
   */
  const ours = quote ? await sentByAgent(conversation.id, quote.text) : false;
  const offerText = quote && !ours && looksLikeOffer(quote.text) ? quote.text : null;
  const choices = offerText ? [] : await openSlots(conversation.id, "CHOICE", now);
  const held = offerText || choices.length > 0 ? null : await recentHeld(conversation.id, now);
  if (!offerText && choices.length === 0 && !held) return undefined;

  const staff: SlotStaffRow[] = await prisma.staff
    .findMany({
      where: { companyId: ctx.companyId, isActive: true, deletedAt: null },
      select: { id: true, name: true, specialty: true },
    })
    .catch(() => []);

  if (held) return changedMind(ctx, conversation, own, held, staff, now);

  if (quote && offerText) {
    const offer = parseStatusOffer(offerText, staff);
    if (!offer) return undefined;
    // «Спасибо», «не надо», вопрос о цене — не просьба взять окошко.
    if (!wantsSlot(own)) return undefined;
    // Медицинский вопрос идёт своей веткой (§6): там зовут человека и врача.
    if (medical(own) && hasQuestion(own)) return undefined;
    // Новый ответ на статус отменяет прежний недоговорённый выбор.
    await releaseOpen(conversation.id);
    return freshStatusOffer(ctx, conversation, own, quote, offer, now);
  }
  return chooseStatusSlot(ctx, conversation, own, choices, staff, now);
}

/**
 * Окошко уже закреплено, а пациент пишет снова: передумал или просит другое
 * время из того же статуса.
 *
 * «16:50» после закреплённого 16:00 уходило в модель, и та отвечала невпопад —
 * «окошко закрепили» и тут же просьбу прислать данные. Отказ («не надо»,
 * «передумала») окошко держал до самого времени приёма: другим пациентам агент
 * говорил «занято». Теперь оба случая разбирает код. Всё остальное — обычный
 * разговор: закреплённое окошко не мешает спросить адрес или цену.
 */
async function changedMind(
  ctx: AgentContext,
  conversation: { id: string; patientId: string | null },
  own: string,
  held: OpenSlot,
  staff: SlotStaffRow[],
  now: Date,
): Promise<AgentReply | null | undefined> {
  const person = staff.find((p) => p.id === held.staffId);
  if (!person) return undefined;
  const phrase = staffPhrase(held.statusText, person);
  const heldWhen = slotWhen(held.startAt);

  /**
   * Отказ — только короткой репликой: «Не смогу прийти в 16:00, можно в
   * 16:50?» — это не отказ, а просьба о другом времени (ниже).
   */
  const pick = pickIn(own, now, CLINIC_TZ);
  const short = own.trim().split(/\s+/).length <= 6;
  const heldMinute = clinicMinuteOfDay(held.startAt);
  // «Не смогу в 10:20» называет само закреплённое время — это тоже отказ.
  const onlyHeldTime =
    pick.minutes.every((m) => m === heldMinute) && pick.hours.every((h) => h === Math.floor(heldMinute / 60));
  /**
   * «Нет, спасибо» — отказ от окошка, только если отвечают на разговор о нём.
   * Агент мог спросить о другом («подсказать что-то ещё?»), и снять окошко в
   * ответ на это значит отдать чужому время, которое человек не отпускал.
   * Слова «передумал», «отмените», «окошко», «запись» говорят о нём сами.
   */
  const aboutSlot =
    /(?<!\p{L})(?:передумал\p{L}*|отмен\p{L}*|окошк\p{L}*|запис\p{L}*)(?!\p{L})/iu.test(own) ||
    (await lastAgentText(conversation.id))?.includes(hhmm(heldMinute)) === true;
  if (short && !hasQuestion(own) && onlyHeldTime && declinesSlot(own) && aboutSlot) {
    await releaseHeld(held.id);
    await noteForAdmin(
      ctx.companyId,
      conversation.id,
      `Пациент отказался от окошка из статуса: ${heldWhen}, ${person.name}. Окошко снято — если запись уже оформлена в YCLIENTS, её нужно отменить.`,
    );
    await escalate(ctx.companyId, conversation.id, "PATIENT_REQUEST", `Пациент отказался от окошка: ${heldWhen}, ${person.name}`).catch(() => {});
    return respond(ctx, conversation.id, {
      text: `Поняла, окошко на ${heldWhen} ${phrase} сняли. Если понадобится другое время — напишите, администратор подберёт.`,
    });
  }

  // Другое время из того же статуса — только если оно там есть и оно одно.
  const offered = timesIn(held.statusText).filter((m) => m !== heldMinute);
  const wanted = pick.minutes.length
    ? offered.filter((m) => pick.minutes.includes(m))
    : pick.hours.length
      ? offered.filter((m) => pick.hours.includes(Math.floor(m / 60)))
      : [];
  if (wanted.length !== 1) return undefined;

  const startAt = clinicMoment(clinicDateKey(held.startAt), wanted[0], CLINIC_TZ);
  if (startAt <= now) return undefined;

  /**
   * «Можно ещё на 13:50 сына?» — второе окошко для другого человека, а не
   * замена своего. Перенести закреплённое значило бы оставить без времени
   * того, кто его уже получил. Второе окошко — со своими данными, и решает
   * администратор.
   */
  if (forSomeoneElse(own) || /(?<!\p{L})(?:ещ[её]|тоже|также|плюс|втор\p{L}*)(?!\p{L})/iu.test(own)) {
    return slotHandover(
      ctx,
      conversation.id,
      `Передал(а) администратору — он проверит окошко на ${hhmm(wanted[0])} и напишет здесь же. За вами остаётся ${heldWhen} ${phrase}.`,
      `Пациент просит ещё одно окошко из статуса: ${hhmm(wanted[0])}, ${person.name}`,
    );
  }
  const result = await switchHold(
    { ...held, companyId: ctx.companyId, conversationId: conversation.id, patientId: conversation.patientId },
    startAt,
    now,
  );
  const newWhen = slotWhen(startAt);
  if (result.kind === "held") {
    await noteForAdmin(
      ctx.companyId,
      conversation.id,
      `Пациент выбрал другое окошко из статуса: ${newWhen} вместо ${heldWhen}, ${person.name}. ` +
        "Оформите запись на новое время в YCLIENTS.",
    );
    await escalate(ctx.companyId, conversation.id, "PATIENT_REQUEST", `Окошко перенесено: ${newWhen} вместо ${heldWhen}, ${person.name}`).catch(() => {});
    return respond(ctx, conversation.id, {
      text:
        `Хорошо, запишем вас на ${newWhen} ${phrase} вместо ${hhmm(heldMinute)}. ` +
        "Окошко закрепили за вами — администратор оформит запись и подтвердит здесь же.",
    });
  }
  if (result.kind === "booked") {
    return respond(ctx, conversation.id, { text: `Вы уже записаны на ${newWhen} ${phrase}.` });
  }
  // Занято — прежнее окошко остаётся за человеком, и это надо сказать.
  return respond(ctx, conversation.id, {
    text: `Окошко на ${hhmm(wanted[0])} уже заняли — за вами остаётся ${heldWhen} ${phrase}.`,
  });
}

/** Цитата — одна из наших собственных реплик в этой переписке за двое суток. */
async function sentByAgent(conversationId: string, quoteText: string): Promise<boolean> {
  const key = (t: string) => t.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  const wanted = key(quoteText);
  if (!wanted) return false;
  const rows = await prisma.message
    .findMany({
      where: {
        conversationId,
        direction: "OUT",
        authorType: "BOT",
        deletedAt: null,
        createdAt: { gt: new Date(Date.now() - 48 * 3600_000) },
      },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { body: true },
    })
    .catch(() => []);
  return rows.some((m) => key(m.body) === wanted);
}

/** Последняя реплика агента в переписке. */
async function lastAgentText(conversationId: string): Promise<string | null> {
  const row = await prisma.message
    .findFirst({
      where: { conversationId, direction: "OUT", authorType: "BOT", deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: { body: true },
    })
    .catch(() => null);
  return row?.body ?? null;
}

/** Передать окошко администратору, ничего не обещая. */
async function slotHandover(ctx: AgentContext, conversationId: string, text: string, note: string): Promise<AgentReply | null> {
  await escalate(ctx.companyId, conversationId, "PATIENT_REQUEST", note).catch(() => {});
  return respond(ctx, conversationId, { text });
}

/** «на 12:15» / «на 09:40, 12:15» — время из статуса, без дня. */
function timesLabel(minutes: number[]): string {
  return minutes.map(hhmm).join(", ");
}

async function freshStatusOffer(
  ctx: AgentContext,
  conversation: { id: string; patientId: string | null },
  own: string,
  quote: AgentQuote,
  offer: StatusOffer<SlotStaffRow>,
  now: Date,
): Promise<AgentReply | null> {
  const excerpt = quote.text.slice(0, 200);
  const doctor = offer.staff ? ` ${staffPhrase(quote.text, offer.staff)}` : "";

  /**
   * Пациент назвал своё время. Оно из статуса — берём его; нет — это уже не
   * окошко клиники, а пожелание, и решает администратор. «В 13» без минут
   * сужает выбор до окошек этого часа.
   */
  const pick = pickIn(own, now, CLINIC_TZ);
  let minutes = offer.times;
  if (pick.minutes.length > 0) {
    minutes = offer.times.filter((m) => pick.minutes.includes(m));
    if (minutes.length === 0) {
      return slotHandover(
        ctx,
        conversation.id,
        `Передал(а) администратору — он проверит время ${timesLabel(pick.minutes)} и напишет здесь же.`,
        `Пациент отвечает на статус «${excerpt}» и просит ${timesLabel(pick.minutes)}`,
      );
    }
  } else if (pick.hours.length > 0) {
    const byHour = offer.times.filter((m) => pick.hours.includes(Math.floor(m / 60)));
    if (byHour.length > 0) minutes = byHour;
  }

  /**
   * Цитата не от клиники (или не узнали, от кого) и врач не определён — не
   * закрепляем ничего. Но и «на какую услугу?» не спрашиваем: всё нужное
   * администратору уже есть в статусе, на который ответил человек.
   */
  if (!quote.byClinic || !offer.staff) {
    return slotHandover(
      ctx,
      conversation.id,
      `Передал(а) администратору — он проверит окошко на ${timesLabel(minutes)}${doctor} и напишет здесь же.`,
      offer.staffAmbiguous
        ? `Пациент отвечает на статус с окошком, врача по статусу не определить: «${excerpt}»`
        : `Пациент отвечает на статус с окошком: «${excerpt}»`,
    );
  }

  const postedAt = await statusPostedAt(ctx.companyId, quote.id, quote.text).catch(() => null);
  const ref = { postedAt, now };
  const days = candidateDays(offer.day, ref, CLINIC_TZ);
  const candidates = slotCandidates(days.keys, minutes, ref, CLINIC_TZ, offer.day === null);
  const past = candidates.past;
  let future = candidates.future;
  let certain = days.certain;

  /**
   * «Хочу на завтра» — пациент сам назвал день, и его «завтра» считается от
   * сегодняшнего дня: он пишет сейчас. Это снимает вопрос о дне, если дату
   * публикации статуса узнать не удалось.
   */
  if (pick.keys.length > 0) {
    const chosen = future.filter((c) => pick.keys.includes(c.key));
    if (chosen.length > 0) {
      future = chosen;
      certain = true;
    }
  }

  if (future.length === 0) {
    const text =
      past.length > 0
        ? minutes.length > 1
          ? `Окошки на ${timesLabel(minutes)}${doctor} уже прошли. ${SLOT_ELSEWHERE}`
          : `Окошко на ${timesLabel(minutes)}${doctor} уже прошло. ${SLOT_ELSEWHERE}`
        : `Передал(а) администратору — он проверит окошко на ${timesLabel(minutes)}${doctor} и напишет здесь же.`;
    return slotHandover(ctx, conversation.id, text, `Пациент отвечает на статус с окошком: «${excerpt}»`);
  }

  const staffRow = offer.staff;
  const service = await serviceForSlot(ctx.companyId, staffRow.id, offer.audience).catch(() => null);
  const durationMin = service?.durationMin || DEFAULT_DURATION_MIN;

  /**
   * Занятое не предлагаем.
   *
   * В статусе «10:00, 10:50, 13:00, 13:50», а 10:00 уже заняли — перечислить
   * его в вопросе значит дать выбрать и тут же отказать. Проверка здесь — для
   * вопроса; при выборе окошко проверяется ещё раз, под блокировкой.
   */
  const states = await Promise.all(
    future.map((c) =>
      checkSlot({
        companyId: ctx.companyId,
        conversationId: conversation.id,
        patientId: conversation.patientId,
        staffId: staffRow.id,
        startAt: c.at,
        durationMin,
      }).catch(() => "free" as const),
    ),
  );
  const open = future.filter((_, i) => states[i] !== "taken");
  /**
   * Пациент назвал время, а его заняли, — предлагаем свободное из того же
   * статуса. День должен быть известен: иначе и предлагать не на какой день.
   */
  if (open.length === 0 && certain && future.length === 1 && (pick.minutes.length > 0 || pick.hours.length > 0)) {
    const other = await freeFromSameStatus(ctx, conversation.id, {
      staff: staffRow,
      startAt: future[0].at,
      durationMin,
      serviceId: service?.id ?? null,
      statusText: quote.text,
      statusExternalId: quote.id,
    }, now).catch(() => null);
    if (other !== null) return other;
  }
  if (open.length === 0) {
    const text =
      future.length > 1
        ? `Окошки на ${timesLabel([...new Set(future.map((c) => c.minute))])}${doctor} уже заняли. ${SLOT_ELSEWHERE}`
        : `Окошко на ${slotWhen(future[0].at)}${doctor} уже заняли. ${SLOT_ELSEWHERE}`;
    return slotHandover(
      ctx,
      conversation.id,
      text,
      `Окошко из статуса уже занято: «${excerpt}» — предложите пациенту другое время`,
    );
  }

  /**
   * Одно окошко, день известен точно — решаем сразу. Но если в статусе их было
   * несколько, а пациент время не называл (остальные прошли или заняты),
   * закреплять молча нельзя: он мог хотеть другое. Спрашиваем.
   */
  const choseHimself = pick.minutes.length > 0 || pick.hours.length > 0 || offer.times.length === 1;
  if (open.length === 1 && certain && choseHimself) {
    return settleStatusSlot(ctx, conversation, own, {
      staff: staffRow,
      startAt: open[0].at,
      durationMin,
      service,
      statusText: quote.text,
      statusExternalId: quote.id,
    });
  }
  future = open;

  /**
   * Иначе спрашиваем — одним вопросом. Варианты запоминаем, чтобы понять ответ
   * «12:15» или «завтра» следующей репликой.
   */
  await openSlotRows(
    {
      companyId: ctx.companyId,
      conversationId: conversation.id,
      patientId: conversation.patientId,
      state: "CHOICE",
      statusText: quote.text,
      statusExternalId: quote.id,
    },
    future.map((c) => ({ staffId: staffRow.id, serviceId: service?.id ?? null, startAt: c.at, durationMin })),
  );
  return respond(ctx, conversation.id, {
    text: slotQuestion(
      future.map((c) => c.at),
      doctor,
      certain && future.length === 1 ? "left" : "ask",
    ),
  });
}

/**
 * Вопрос о выборе: время, день или подтверждение.
 *
 * День, выведенный нами, пациенту не называется как факт: «на завтра» без
 * времени публикации статуса — это сегодня или завтра, и спросить дешевле,
 * чем ждать человека не в тот день.
 */
function slotQuestion(
  options: Date[],
  doctor: string,
  /** left — из нескольких окошек статуса осталось одно, день известен. */
  mode: "ask" | "left" = "ask",
): string {
  if (mode === "left" && options.length === 1) {
    return `Из окошек в статусе свободно ${slotWhen(options[0])}${doctor}. Записать вас?`;
  }
  const minutes = [...new Set(options.map((d) => clinicMinuteOfDay(d)))];
  const keys = [...new Set(options.map((d) => clinicDateKey(d)))];
  if (minutes.length > 1) {
    const list = minutes.map(hhmm);
    const spoken = `${list.slice(0, -1).join(", ")} или ${list[list.length - 1]}`;
    return `В статусе несколько окошек${doctor}. Какое время вам удобнее — ${spoken}?`;
  }
  if (keys.length > 1) {
    const [a, b] = [...options].sort((x, y) => x.getTime() - y.getTime());
    return `Уточните, пожалуйста: окошко на ${hhmm(minutes[0])}${doctor} — на ${dayWhen(a)} или на ${dayWhen(b)}?`;
  }
  return `Уточните, пожалуйста: окошко на ${slotWhen(options[0])}${doctor} — верно?`;
}

/** Ответ пациента на наш вопрос о выборе. */
async function chooseStatusSlot(
  ctx: AgentContext,
  conversation: { id: string; patientId: string | null },
  own: string,
  choices: OpenSlot[],
  staff: SlotStaffRow[],
  now: Date,
): Promise<AgentReply | null | undefined> {
  const pick = pickIn(own, now, CLINIC_TZ);
  const narrowed = pick.minutes.length + pick.hours.length + pick.keys.length + pick.days.length > 0;

  if (pick.no && !narrowed) {
    await releaseOpen(conversation.id);
    return slotHandover(
      ctx,
      conversation.id,
      "Поняла. Передал(а) администратору — он подберёт удобное время и напишет здесь же.",
      `Пациент не подтвердил окошко из статуса: «${choices[0].statusText.slice(0, 200)}»`,
    );
  }

  let rows = choices;
  if (pick.minutes.length) rows = rows.filter((r) => pick.minutes.includes(clinicMinuteOfDay(r.startAt)));
  else if (pick.hours.length) rows = rows.filter((r) => pick.hours.includes(Math.floor(clinicMinuteOfDay(r.startAt) / 60)));
  if (pick.keys.length) rows = rows.filter((r) => pick.keys.includes(clinicDateKey(r.startAt)));
  else if (pick.days.length) rows = rows.filter((r) => pick.days.includes(Number(clinicDateKey(r.startAt).slice(8, 10))));

  const doctorOf = (r: OpenSlot) => {
    const person = staff.find((p) => p.id === r.staffId);
    return person ? ` ${staffPhrase(r.statusText, person)}` : "";
  };

  if (!narrowed) {
    // «Да» на «верно?» — выбор сделан. «Да» на «какое время?» — не ответ.
    if (pick.yes && choices.length === 1) rows = choices;
    else if (pick.yes) return respond(ctx, conversation.id, { text: slotQuestion(choices.map((c) => c.startAt), doctorOf(choices[0])) });
    // Человек заговорил о другом — выбор не навязываем, варианты истекут сами.
    else return undefined;
  }

  if (rows.length === 0) {
    await releaseOpen(conversation.id);
    return slotHandover(
      ctx,
      conversation.id,
      "Передал(а) администратору — он проверит это время и напишет здесь же.",
      // Слова пациента в уведомление не кладём: администратор прочтёт их в переписке.
      "Пациент выбрал время не из статуса — подберите время",
    );
  }
  if (rows.length > 1) {
    await releaseOpen(conversation.id, rows.map((r) => r.id));
    return respond(ctx, conversation.id, { text: slotQuestion(rows.map((r) => r.startAt), doctorOf(rows[0])) });
  }

  const row = rows[0];
  const person = staff.find((p) => p.id === row.staffId);
  if (!person) {
    await releaseOpen(conversation.id);
    return slotHandover(ctx, conversation.id, "Передал(а) администратору — он проверит окошко и напишет здесь же.", "Врач окошка больше не в справочнике");
  }
  const service = row.serviceId
    ? await prisma.service
        .findUnique({ where: { id: row.serviceId }, select: { id: true, title: true, price: true, durationMin: true } })
        .then((s) => (s ? { ...s, price: Number(s.price) } : null))
        .catch(() => null)
    : null;
  return settleStatusSlot(ctx, conversation, own, {
    staff: person,
    startAt: row.startAt,
    durationMin: row.durationMin,
    service,
    statusText: row.statusText,
    statusExternalId: row.statusExternalId,
    rowId: row.id,
  });
}

interface SettleInput {
  staff: SlotStaffRow;
  startAt: Date;
  durationMin: number;
  service: SlotService | null;
  statusText: string;
  statusExternalId: string | null;
  /** Строка варианта, если окошко выбрано из предложенных. */
  rowId?: string;
}

/**
 * Окошко определено — свободно ли оно и что сказать.
 *
 *   • занято — так и говорим, время подберёт администратор;
 *   • постоянный пациент записывает себя — закрепляем сразу, без данных;
 *   • новый пациент или записывают другого — окошко «пока свободно», просим
 *     данные, закрепляем, когда они придут (решение заказчика, сентябрь 2026:
 *     кто спросил и пропал, никого не блокирует).
 */
async function settleStatusSlot(
  ctx: AgentContext,
  conversation: { id: string; patientId: string | null },
  own: string,
  slot: SettleInput,
): Promise<AgentReply | null> {
  const when = slotWhen(slot.startAt);
  const phrase = staffPhrase(slot.statusText, slot.staff);
  const ref = {
    companyId: ctx.companyId,
    conversationId: conversation.id,
    patientId: conversation.patientId,
    staffId: slot.staff.id,
    startAt: slot.startAt,
    durationMin: slot.durationMin,
  };

  const state = await checkSlot(ref);
  if (state !== "free") return slotOutcome(ctx, conversation.id, { kind: state }, slot, when, phrase, "status");

  const audience = audienceIn(slot.statusText);
  if (await returningSelf(ctx.companyId, conversation.patientId, own, audience)) {
    const held = await holdSlot({
      ...ref,
      serviceId: slot.service?.id ?? null,
      statusText: slot.statusText,
      statusExternalId: slot.statusExternalId,
      rowId: slot.rowId,
    });
    return slotOutcome(ctx, conversation.id, held, slot, when, phrase, "status");
  }

  // Ждём данные: окошко предлагаем, но пока не держим.
  if (slot.rowId) {
    await markOffered(slot.rowId);
    await releaseOpen(conversation.id, [slot.rowId]);
  } else {
    await releaseOpen(conversation.id);
    await openSlotRows(
      {
        companyId: ctx.companyId,
        conversationId: conversation.id,
        patientId: conversation.patientId,
        state: "OFFERED",
        statusText: slot.statusText,
        statusExternalId: slot.statusExternalId,
      },
      [{ staffId: slot.staff.id, serviceId: slot.service?.id ?? null, startAt: slot.startAt, durationMin: slot.durationMin }],
    );
  }
  const child = audience === "child" || (audience === null && forSomeoneElse(own) && whomFor(own) === "child");
  const weight = /остеопат/i.test(`${slot.service?.title ?? ""} ${slot.staff.specialty ?? ""}`);
  return respond(ctx, conversation.id, {
    text:
      `Окошко на ${when} ${phrase} пока свободно.${slotPriceLine(slot.service)} ` +
      `Чтобы закрепить его за вами, пришлите, пожалуйста, одним сообщением: ${slotDataFields(child, weight)}.`,
    bookingContext: true,
  });
}

/**
 * Окошко заняли, но в том же статусе есть свободное — предлагаем его.
 *
 * «Окошко на 09:00 уже заняли — передал администратору» отправляло человека
 * ждать, хотя свободное время лежало в том же статусе, на который он ответил.
 * Теперь: «уже заняли, но свободно 12:00 — записать вас?». Администратору —
 * только когда в статусе не осталось ничего.
 *
 * null — предложить нечего, говорим «заняли» как прежде.
 */
async function freeFromSameStatus(
  ctx: AgentContext,
  conversationId: string,
  taken: { staff: SlotStaffRow; startAt: Date; durationMin: number; serviceId: string | null; statusText: string; statusExternalId: string | null },
  now: Date = new Date(),
): Promise<AgentReply | null> {
  const key = clinicDateKey(taken.startAt);
  const takenMinute = clinicMinuteOfDay(taken.startAt);
  const patientId =
    (await prisma.conversation.findUnique({ where: { id: conversationId }, select: { patientId: true } }).catch(() => null))
      ?.patientId ?? null;
  const others = timesIn(taken.statusText)
    .filter((m) => m !== takenMinute)
    .map((m) => ({ minute: m, at: clinicMoment(key, m, CLINIC_TZ) }))
    .filter((c) => c.at > now);
  if (others.length === 0) return null;
  const states = await Promise.all(
    others.map((c) =>
      checkSlot({ companyId: ctx.companyId, conversationId, patientId, staffId: taken.staff.id, startAt: c.at, durationMin: taken.durationMin })
        .catch(() => "taken" as const),
    ),
  );
  const free = others.filter((_, i) => states[i] === "free");
  if (free.length === 0) return null;

  await releaseOpen(conversationId);
  await openSlotRows(
    { companyId: ctx.companyId, conversationId, patientId, state: "CHOICE", statusText: taken.statusText, statusExternalId: taken.statusExternalId },
    free.map((c) => ({ staffId: taken.staff.id, serviceId: taken.serviceId, startAt: c.at, durationMin: taken.durationMin })),
  );
  const phrase = staffPhrase(taken.statusText, taken.staff);
  const head = `Окошко на ${hhmm(takenMinute)} уже заняли`;
  if (free.length === 1) {
    return respond(ctx, conversationId, { text: `${head}, но свободно ${slotWhen(free[0].at)} ${phrase}. Записать вас?` });
  }
  const list = free.map((c) => hhmm(c.minute));
  const spoken = `${list.slice(0, -1).join(", ")} или ${list[list.length - 1]}`;
  return respond(ctx, conversationId, {
    text: `${head}. Свободно ещё ${dayWhen(free[0].at)} ${phrase}: ${spoken}. Какое время вам удобнее?`,
  });
}

/**
 * Что сказать по итогу проверки или закрепления.
 *
 * `via` — откуда пришли: ответ на статус или присланная анкета. После анкеты
 * благодарим за данные: человек их только что прислал, и промолчать об этом —
 * значит оставить его гадать, дошли ли они.
 */
async function slotOutcome(
  ctx: AgentContext,
  conversationId: string,
  result: HoldResult,
  slot: SettleInput,
  when: string,
  phrase: string,
  via: "status" | "intake",
): Promise<AgentReply | null> {
  const thanks = via === "intake" ? "Спасибо, данные передал(а) администратору. " : "";
  const service = slot.service ? `, ${slot.service.title}` : "";
  const excerpt = slot.statusText.slice(0, 200);

  switch (result.kind) {
    case "held": {
      await releaseOpen(conversationId);
      await noteForAdmin(
        ctx.companyId,
        conversationId,
        `Ассистент закрепил окошко из статуса: ${when}, ${slot.staff.name}${service}. ` +
          `Оформите запись в YCLIENTS и подтвердите пациенту. Статус: «${excerpt}»`,
      );
      await escalate(
        ctx.companyId,
        conversationId,
        "PATIENT_REQUEST",
        `Окошко закреплено: ${when}, ${slot.staff.name}${service} — оформите запись`,
      ).catch(() => {});
      return respond(ctx, conversationId, {
        text:
          via === "intake"
            ? `Спасибо! Окошко на ${when} ${phrase} закрепили за вами — администратор оформит запись и подтвердит здесь же.`
            : `Хорошо, запишем вас на ${when} ${phrase}. Окошко закрепили за вами — администратор оформит запись и подтвердит здесь же.`,
      });
    }
    case "mine":
      await releaseOpen(conversationId);
      return respond(ctx, conversationId, {
        text: `${thanks}Окошко на ${when} ${phrase} уже закреплено за вами — администратор оформит запись и подтвердит здесь же.`,
      });
    case "booked":
      await releaseOpen(conversationId);
      return respond(ctx, conversationId, { text: `${thanks}Вы уже записаны на ${when} ${phrase}.` });
    case "taken": {
      // После анкеты данные уже у администратора — время подберёт он.
      if (via === "status") {
        const other = await freeFromSameStatus(ctx, conversationId, {
          staff: slot.staff,
          startAt: slot.startAt,
          durationMin: slot.durationMin,
          serviceId: slot.service?.id ?? null,
          statusText: slot.statusText,
          statusExternalId: slot.statusExternalId,
        }).catch(() => null);
        if (other !== null) return other;
      }
      await releaseOpen(conversationId);
      return slotHandover(
        ctx,
        conversationId,
        `${thanks}Окошко на ${when} ${phrase} уже заняли. ${SLOT_ELSEWHERE}`,
        `Окошко из статуса уже занято: ${when}, ${slot.staff.name} — предложите пациенту другое время`,
      );
    }
    case "limit":
      await releaseOpen(conversationId);
      return slotHandover(
        ctx,
        conversationId,
        `${thanks}Передал(а) администратору — он оформит запись и напишет здесь же.`,
        `Пациент просит ещё одно окошко из статуса, за ним уже закреплено несколько: ${when}, ${slot.staff.name}`,
      );
  }
}

/**
 * Присланная анкета закрепляет окошко, предложенное раньше.
 *
 * null — предложенного окошка нет, анкета обрабатывается как обычно.
 */
async function holdOfferedSlot(
  ctx: AgentContext,
  conversation: { id: string; patientId: string | null },
): Promise<AgentReply | null | undefined> {
  const offered = await openSlots(conversation.id, "OFFERED");
  // Двух предложенных окошек сразу быть не должно; если так вышло — не выбираем за человека.
  if (offered.length !== 1) return undefined;
  const row = offered[0];
  const person = await prisma.staff
    .findFirst({ where: { id: row.staffId, isActive: true, deletedAt: null }, select: { id: true, name: true, specialty: true } })
    .catch(() => null);
  if (!person) return undefined;
  const service = row.serviceId
    ? await prisma.service
        .findUnique({ where: { id: row.serviceId }, select: { id: true, title: true, price: true, durationMin: true } })
        .then((x) => (x ? { ...x, price: Number(x.price) } : null))
        .catch(() => null)
    : null;
  const slot: SettleInput = {
    staff: person,
    startAt: row.startAt,
    durationMin: row.durationMin,
    service,
    statusText: row.statusText,
    statusExternalId: row.statusExternalId,
    rowId: row.id,
  };
  const held = await holdSlot({
    companyId: ctx.companyId,
    conversationId: conversation.id,
    patientId: conversation.patientId,
    staffId: person.id,
    startAt: row.startAt,
    durationMin: row.durationMin,
    serviceId: row.serviceId,
    statusText: row.statusText,
    statusExternalId: row.statusExternalId,
    rowId: row.id,
  });
  return slotOutcome(ctx, conversation.id, held, slot, slotWhen(row.startAt), staffPhrase(row.statusText, person), "intake");
}

/** Просьба о данных после согласия, если окошко уже предложено. */
async function offeredSlotAsk(conversationId: string): Promise<string | null> {
  const offered = await openSlots(conversationId, "OFFERED");
  if (offered.length !== 1) return null;
  const row = offered[0];
  const person = await prisma.staff
    .findFirst({ where: { id: row.staffId, isActive: true, deletedAt: null }, select: { id: true, name: true, specialty: true } })
    .catch(() => null);
  if (!person) return null;
  const service = row.serviceId
    ? await prisma.service.findUnique({ where: { id: row.serviceId }, select: { title: true } }).catch(() => null)
    : null;
  const child = audienceIn(row.statusText) === "child";
  const weight = /остеопат/i.test(`${service?.title ?? ""} ${person.specialty ?? ""}`);
  return (
    `Спасибо! Чтобы закрепить за вами окошко на ${slotWhen(row.startAt)} ${staffPhrase(row.statusText, person)}, ` +
    `пришлите, пожалуйста, одним сообщением: ${slotDataFields(child, weight)}.`
  );
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
  conversation: { id: string; consentGrantedAt: Date | null; patientId: string | null },
  text: string,
  /** Цитата провайдера — только у свежего сообщения, при повторной обработке её нет. */
  quote: AgentQuote | null = null,
): Promise<AgentReply | null> {
  const settings = await assistantMode(ctx.companyId);
  /**
   * Слова самого пациента, без цитаты (lib/agent/quoted).
   *
   * По ним принимаются все решения: стоп-слова, медицинские правила, тема
   * разговора. Цитата — это текст собеседника, и судить по нему о намерении
   * пациента нельзя: стоп-слово «окошко» из сообщения КЛИНИКИ обрывало
   * просьбу записать ребёнка на полуслове.
   *
   * Модели и поиску по справочнику уходит текст целиком: там цитата — полезный
   * контекст, из неё видно, о какой услуге и о каком враче речь.
   */
  const own = withoutQuote(text);
  /**
   * Имена сотрудников: по ним отличаем выбор врача от присланного ФИО
   * («Взрослый Разият Резванова» — это врач, а не персональные данные).
   */
  const clinicStaffNames = await staffNamesOf(ctx.companyId).catch(() => []);

  // Режим «выключен»: агент молчит полностью, диалог ведёт человек.
  if (settings.mode === "off") {
    await escalate(ctx.companyId, conversation.id, "PATIENT_REQUEST", "Ассистент выключен в настройках").catch(() => {});
    return null;
  }

  /**
   * Окошко из статуса — раньше стоп-слов и всего остального.
   *
   * Пациент ответил на статус «Окошко на завтра к Ирине Алилгаджиевне ✅ 09:40»
   * — и слышал «на какую услугу хотите?», хотя всё написано в том, на что он
   * отвечал. Только в рабочем режиме: в режиме черновиков агент сам не отвечает.
   */
  if (settings.mode === "on") {
    const slot = await statusSlotReply(ctx, conversation, own, quote).catch((e) => {
      // Сбой окошка не должен лишать человека ответа: дальше — обычный путь.
      console.error("[agent] окошко из статуса не обработано:", (e as Error)?.message ?? e);
      return undefined;
    });
    if (slot !== undefined) return slot;
  }

  // Стоп-слова из настроек: клиника сама решает, о чём агент не говорит.
  if (hitsStopWord(own, settings.stopWords)) {
    await escalate(ctx.companyId, conversation.id, "KEYWORD", "Стоп-слово из настроек").catch(() => {});

    /**
     * Стоп-слово запрещает агенту ГОВОРИТЬ на тему, но не мешает собрать то,
     * что администратор всё равно спросит.
     *
     * У клиники в стоп-словах стоит «окно». Человек написал «нет случайно
     * свободное окошко к Алункачевой, 2-х месячный ребенок» и услышал только
     * «передал администратору» — а тому потом пришлось собирать услугу и
     * данные с нуля. Ниже по коду для этого же вопроса давно есть правильный
     * ответ, но стоп-слово возвращалось раньше и обрывало всё.
     *
     * Границы не двигаются: времени агент по-прежнему не называет, записи не
     * создаёт, о самой теме не рассуждает. Вопрос про услугу и «взрослому или
     * ребёнку» персональных данных не касается (§7) и задаётся свободно.
     */
    const moving = wantsReschedule(own) && !asksAboutOwnBooking(own);
    const slotAsk = scheduleTopic(own) && asksForSlot(own) && !moving;
    return respond(ctx, conversation.id, {
      text: moving
        ? "Поняла, передал(а) администратору — он подберёт время из тех, что вы просите, и напишет здесь же."
        : slotAsk
        ? await (async () => {
            const turns = await recentTurns(conversation.id);
            return slotHandoverText(ctx.companyId, [
              own,
              ...turns.filter((t) => t.role === "user").map((t) => t.content),
            ]);
          })()
        : "Передал(а) администратору — он ответит здесь же.",
    });
  }

  // Режим «только черновики»: агент сам не отвечает, а зовёт человека.
  // Автономная работа включается в настройках осознанно (§6.4).
  if (settings.mode === "drafts") {
    await escalate(ctx.companyId, conversation.id, "AGENT_REQUEST", "Ассистент в режиме черновиков").catch(() => {});
    return respond(ctx, conversation.id, {
      text: "Передал(а) ваш вопрос администратору — он ответит здесь же.",
    });
  }

  /**
   * Работа, реклама, сотрудничество — вопрос к клинике как к организации.
   *
   * Такие письма приходят в тот же пациентский чат, и «этот вопрос лучше
   * уточнить у специалиста» на них звучит глупо: человек не лечиться пришёл.
   * Отвечает на них руководство, ему и передаём — вместе с эскалацией
   * администратору, чтобы вопрос не потерялся, если руководитель занят.
   */
  if (managementTopic(own)) {
    await escalate(ctx.companyId, conversation.id, "PATIENT_REQUEST", "Вопрос к руководству клиники").catch(() => {});
    const asked = await askSpecialist({
      companyId: ctx.companyId,
      conversationId: conversation.id,
      patientId: conversation.patientId,
      kind: "MANAGEMENT",
      patientName: await patientNameFor(conversation.id),
      channelLabel: channelLabel(ctx.channel),
    }).catch(() => ({ sent: false as const, reason: "сбой отправки" }));
    return respond(ctx, conversation.id, {
      text: asked.sent
        ? (asked.reply ?? "Передал(а) ваш вопрос руководству клиники — ответим здесь же.")
        : "Передал(а) ваш вопрос руководству клиники — ответим здесь же.",
    });
  }

  /**
   * Вопрос о своей записи агент отвечает сам.
   *
   * «К какому специалисту я записана?» — это не жалоба и не просьба перенести:
   * ответ лежит в базе, агент видит и услугу, и врача, и день. Прежде такой
   * вопрос уходил человеку по слову «записана», и пациентка слышала «передал
   * администратору, он подберёт время», которого не просила.
   *
   * Жалобы, деньги и анализы это исключение не затрагивает.
   */
  /**
   * Анкета со словом «жалобы» — это симптомы, а не жалоба на клинику.
   *
   * «Магомедов Али, 6 лет, мама Гульбара, жалобы на осанку» уходило сюда: слово
   * «жалоб» стоит и в правиле личных тем, и в правиле «позовите человека».
   * Пациент слышал «передал администратору» вместо «данные приняты», руководству
   * уходило письмо о претензии, а окошко из статуса, ждавшее этих данных, так
   * и не закреплялось. Для анкеты считаем только жалобу на клинику и прямую
   * просьбу позвать человека.
   */
  const intakeLike = looksLikeIntake(own, clinicStaffNames);
  const personal = intakeLike
    ? complainsAboutClinic(own) || wantsHuman(own.replace(/жалоб\p{L}*/giu, " "))
    : personalTopic(own) || wantsHuman(own);
  if (!asksAboutOwnBooking(own) && personal) {
    await escalate(ctx.companyId, conversation.id, "PATIENT_REQUEST", "Личный вопрос или жалоба").catch(() => {});

    /**
     * Жалобу видит руководство, а не только администратор.
     *
     * Претензия к клинике — решение руководителя: вернуть деньги, извиниться,
     * разобрать случай. Администратор всё равно позовёт его, только на день
     * позже. Просьба «позовите человека» сюда не входит: это работа
     * администратора, и беспокоить руководителя незачем.
     */
    const complaint = intakeLike
      ? complainsAboutClinic(own)
      : /жалоб|жалова|претенз|вернуть деньги|возврат|юрист|врач ошибс/i.test(own);
    if (complaint) {
      await askSpecialist({
        companyId: ctx.companyId,
        conversationId: conversation.id,
        patientId: conversation.patientId,
        kind: "MANAGEMENT",
        patientName: await patientNameFor(conversation.id),
        channelLabel: channelLabel(ctx.channel),
      }).catch(() => ({ sent: false as const }));
    }
    return respond(ctx, conversation.id, { text: "Передал(а) администратору — он ответит здесь же." });
  }

  const said = await recentTurns(conversation.id);

  /**
   * «Хорошо», «спасибо», «до свидания» — отвечаем сами.
   *
   * Это подтверждение, а не вопрос. На боевом стенде такое «Хорошо» ушло в
   * модель, та промолчала, и сработал запасной путь: «Секунду, передаю ваш
   * вопрос администратору». Администратора позвали на слово «хорошо».
   *
   * Проверяем после ветки согласия и до всего остального, но только вне
   * оформления записи: там короткое «да» — ответ на вопрос агента, а не
   * вежливость.
   */
  if (!inIntakeFlow(said)) {
    /**
     * «Ага» на вопрос агента — ответ, а не вежливость.
     *
     * «Вам нужна запись на приём?» → «ага» → «Хорошо, если появятся вопросы —
     * я здесь»: человек согласился записаться, а агент его отпустил. Правило
     * молчания на вежливость (`nothingToAnswer`) давно смотрит, спрашивал ли
     * агент, — эта ветка не смотрела. «Спасибо» и «до свидания» по-прежнему
     * получают вежливый ответ: это не согласие.
     */
    const lastAgent = [...said].reverse().find((t) => t.role === "assistant")?.content;
    const answersAgent = isAcknowledgement(own) && lastAgent !== undefined && agentAskedSomething(lastAgent);
    const polite = answersAgent ? null : smallTalkReply(own);
    if (polite) return respond(ctx, conversation.id, { text: polite });
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
  const intakeSent = looksLikeIntake(own, clinicStaffNames);
  if (intakeSent) {
    /**
     * Данные прислали, а согласия нет — принимать их нельзя (§7).
     *
     * Мама прислала ФИО и возраст обоих детей, не ответив на запрос согласия,
     * и получила «спасибо, передала администратору». То есть персональные
     * данные были собраны и переданы дальше без согласия — ровно то, ради
     * чего весь этот механизм и существует.
     *
     * Имя в карточку не запоминаем и «спасибо, записал(а)» не говорим.
     * Администратора зовём: он возьмёт согласие голосом и доведёт запись.
     */
    const consentOk = await prisma.conversation
      .findUnique({ where: { id: conversation.id }, select: { consentGrantedAt: true } })
      .catch(() => null);
    if (consentOk && !consentOk.consentGrantedAt) {
      await escalate(
        ctx.companyId,
        conversation.id,
        "PATIENT_REQUEST",
        "Пациент прислал данные для записи до согласия на обработку",
      ).catch(() => {});
      const request = await consentRequestFor(ctx.companyId, conversation.id).catch(() => null);
      return respond(ctx, conversation.id, {
        text: request ? request.text + consentHint(ctx.channel) : CONSENT_REMINDER,
        buttons: request?.buttons ?? consentButtons(),
        platformConsent: true,
      });
    }

    /**
     * Имя из анкеты запоминаем сразу.
     *
     * Пациент представился полным именем, а через две реплики услышал «вы его
     * не называли»: имя было в переписке, но в промпт уходят последние
     * сообщения, и всё, что дальше, для агента не существует. В карточке оно
     * нужно и администратору — диалог перестаёт быть безымянным.
     */
    await rememberName(ctx.companyId, conversation.id, nameFromIntake(own)).catch(() => {});

    /**
     * Окошко из статуса ждало этих данных — закрепляем его (решение заказчика,
     * сентябрь 2026: новому пациенту окошко закрепляется, когда пришли данные).
     * Проверка занятости идёт заново: пока человек писал анкету, окошко могли
     * занять.
     */
    if (!hasQuestion(own)) {
      const slot = await holdOfferedSlot(ctx, conversation).catch((e) => {
        console.error("[agent] окошко по анкете не закреплено:", (e as Error)?.message ?? e);
        return undefined;
      });
      if (slot !== undefined) return slot;
    }
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
    if (!hasQuestion(own)) {
      return respond(ctx, conversation.id, {
        /**
         * «Передал(а)», а не «записал(а)». Агент не записывает на приём, а
         * «записал» пациент читает именно так: через реплику он просил «найдите
         * ближайшую запись» и получал «записи впереди я у вас не вижу» —
         * два сообщения подряд противоречили друг другу.
         */
        text: "Спасибо, передал(а) ваши данные администратору. Он подберёт ближайшее удобное время и напишет здесь же.",
      });
    }
  }

  /**
   * Приветствие. Клиника задаёт его в «Настройки → Ассистент», и до сих пор
   * это поле было чистой декорацией: агент его не читал ни разу, а на «Добрый
   * день» отвечал тем, что придумает модель. Здороваться клиника хочет своими
   * словами — это первое, что видит пациент.
   */
  if (/^\/start\b/.test(own) || isGreeting(own)) {
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
    /**
     * Знакомы ли мы — в пределах суток.
     *
     * «Доброе утро! Слушаю вас.» уместно, когда разговор идёт. Но если человек
     * не писал неделю, это новое обращение: он должен услышать приветствие
     * клиники целиком, как в справочнике. История у агента теперь длинная — на
     * шестьдесят дней, — и без границы по времени полная вводная не звучала бы
     * уже никогда.
     */
    const met = (await spokeWithin(conversation.id, MET_WINDOW_MS)) || alreadyGreeted(said, settings.greeting);
    const hello = greetingText({
      incoming: own,
      configured: settings.greeting,
      repeat: met,
    });
    return respond(ctx, conversation.id, { text: hello, buttons: mainMenu() });
  }

  const allKnowledge = await prisma.knowledgeEntry.findMany({
    where: usableKnowledgeWhere(ctx.companyId),
    select: { id: true, topic: true, question: true, answer: true },
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
  /**
   * Оформление записи не отменяет медицинское правило — оно отменяет только
   * чтение АНКЕТЫ как медицинского текста.
   *
   * Исключение появилось потому, что агент сам спрашивает жалобу, а потом
   * пугается собственного вопроса: «взрослая женщина, головная боль» —
   * медицинский текст по словам. Но под него попало и всё остальное: стоило
   * агенту попросить ФИО, и любой следующий вопрос переставал быть
   * медицинским. «А какая капельница мне подойдёт?» ушло в модель, и та
   * назначила инфузию по самочувствию.
   *
   * Анкета — это ответ, а не вопрос. Вопросительный знак исключение снимает.
   */
  if (medical(own) && !(inIntakeFlow(said) && !hasQuestion(own))) {
    const match = matchKnowledge(text, knowledgeRows);
    if (!confidentMatch(match)) {
      await escalate(ctx.companyId, conversation.id, "MEDICAL_QUESTION", "Медицинский вопрос без готового ответа").catch(() => {});
      /**
       * Спросили цену — цену и называем, даже если рядом жалоба.
       *
       * «Сколько стоит капельница от усталости?» — вопрос про деньги, а не про
       * лечение. Из-за слова «усталость» он попадал сюда и получал «уточните у
       * специалиста»: человек спросил цену четыре раза подряд и ни разу её не
       * услышал. Какая именно капельница нужна, решает врач — это остаётся за
       * ним; сказать, сколько стоит названная услуга, мы можем и обязаны.
       */
      const asksPrice =
        /(?<!\p{L})(?:сколько\s+стоит|сколько\s+будет|цена|цены|стоимость|прайс|почём|почем)(?!\p{L})/iu.test(
          own,
        );
      const priced = asksPrice
        ? dedupeServices(matchServices(own, await getServices(ctx.companyId).catch(() => []), 3, 0.5))
        : [];
      const prices = priced
        .map((p) => `${p.title} — ${p.price} ₽${p.durationMin > 0 ? `, ${p.durationMin} мин` : ""}`)
        .join("\n");
      /**
       * Спрашиваем врача — если есть кого и если это не вопрос про цену.
       *
       * Живой случай: «Она говорила отписаться по поводу головных болей, у меня
       * пошли месячные и голова болела как раньше». Ответ на такое знает один
       * человек в клинике, и до сих пор администратор пересылал вопрос ей
       * руками, получал ответ голосом и писал пациентке сам.
       *
       * Врача не трогаем, когда ответ уже нашёлся в справочнике (сюда мы тогда
       * не попадаем вовсе) и когда спрашивают цену: это не к ней.
       */
      /**
       * Врача зовём только на СЛОЖНОЕ.
       *
       * «А это больно?» и «сколько длится приём» — мелочи, на которые
       * администратор ответит быстрее. Письма по пустякам перестают читать, а
       * вместе с ними перестают читать и настоящие. Сложное — это названное
       * состояние, просьба о тактике или разговор после приёма
       * (lib/agent/specialist-rules).
       */
      const askedDoctor: { reply?: string } =
        prices || !complexMedical(questionForDoctor(own, said))
        ? {}
        : await askSpecialist({
            companyId: ctx.companyId,
            conversationId: conversation.id,
            patientId: conversation.patientId,
            kind: "MEDICAL",
            patientName: await patientNameFor(conversation.id),
            channelLabel: channelLabel(ctx.channel),
          }).catch(() => ({ sent: false as const, reply: undefined }));

      return respond(ctx, conversation.id, {
        text: prices
          ? `${prices}\n\nКакая именно подойдёт в вашем случае, скажет специалист — ` +
            "передал(а) администратору клиники."
          : askedDoctor.reply
            ? askedDoctor.reply
            : "Этот вопрос лучше уточнить у специалиста — передал(а) администратору клиники. " +
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
  /**
   * Человек опаздывает — коротко передаём администратору и молчим.
   *
   * Ждать ли опоздавшего, решает клиника: агент не знает ни расписания, ни
   * того, занят ли следующий слот. На живом прогоне он попытался помочь и
   * посоветовал позвонить, «уточнив номер у администратора», — отправил
   * человека за телефоном клиники к тому же администратору. Требование
   * заказчика прямое: просто сказать, что передал.
   *
   * Проверяется до расписания: «опаздываю на приём» иначе разбиралось бы как
   * вопрос о записи и получало бы рассуждение вместо ответа.
   */
  if (runningLate(own)) {
    await escalate(ctx.companyId, conversation.id, "PATIENT_REQUEST", "Пациент опаздывает").catch(() => {});
    return respond(ctx, conversation.id, {
      text: "Передал(а) администратору — он ответит здесь же.",
    });
  }

  /**
   * Прямой вопрос про день недели: кто из врачей принимает.
   *
   * Отвечаем кодом, а не моделью. «Работаете ли вы в выходные дни? И сколько
   * стоит приём?» получило верный ответ про клинику и цены ОБОИХ остеопатов —
   * при том что в субботу принимает только одна. Администратору пришлось
   * писать вслед за ботом. Имя врача и день приёма — то, из-за чего человек
   * приезжает не в тот день, и гадать здесь нельзя.
   *
   * Отвечаем только когда дни у врачей заданы. Не заданы — молчим об этом
   * вовсе и идём обычной дорогой: пустая настройка не значит «не работает».
   */
  const askedDays = daysAsked(own);
  if (askedDays.length > 0) {
    const doctors = await prisma.staff.findMany({
      where: { companyId: ctx.companyId, isActive: true, deletedAt: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true, specialty: true, workdays: true },
    });
    /**
     * Врача помним из разговора, а не только из последней реплики.
     *
     * «Можно в субботу к Ирине Алилгаджиевне?» — «А в пятницу?»: во второй
     * реплике имени нет, но речь по-прежнему о ней. Без памяти агент терял
     * собеседницу и отвечал «уточню у администратора» на простой вопрос.
     */
    const named =
      staffAsked(own, doctors) ??
      staffAsked(
        said
          .filter((t) => t.role === "user")
          .slice(-3)
          .map((t) => t.content)
          .join("\n"),
        doctors,
      );

    /**
     * Про врачей отвечаем, только когда спросили про врача или про услугу.
     *
     * «Работаете ли вы в выходные?» — вопрос про КЛИНИКУ, а не про остеопатов.
     * Первая версия отвечала на него списком врачей, и получалось, что в
     * субботу в клинике только остеопатия: ни БОС-терапии, ни процедурного
     * кабинета, ни забора крови — как будто их нет. Ответ был верен про одного
     * врача и неверен про клинику.
     *
     * Названа услуга — смотрим тех, кто её ведёт: «в субботу есть БОС?» это
     * вопрос про специалиста по БОС, а не про всех.
     */
    const serviceId = named ? null : await serviceInTalk(ctx.companyId, withoutDays(own), said);
    const runBy = serviceId ? await staffForService(ctx.companyId, serviceId) : [];
    const scope = named
      ? doctors.filter((d) => d.id === named.id)
      : doctors.filter((d) => runBy.includes(d.id));

    /**
     * Второй вопрос в том же сообщении отдаём модели.
     *
     * «Работаете ли вы в выходные дни? И сколько у вас стоит приём?» — здесь
     * два вопроса, и короткий ответ про дни съедал второй. Отвечать на всё
     * сразу умеет модель; наше дело — дать ей точные дни (они в справке) и
     * проверить ответ (wrongWorkday).
     */
    const alsoAsksPrice =
      /(?<!\p{L})(?:сколько\s+стоит|сколько\s+будет|цена|цены|стоимость|прайс|почём|почем|сколько\s+у\s+вас\s+стоит)(?!\p{L})/iu.test(
        own,
      );

    if (named && named.workdays.length > 0 && !alsoAsksPrice) {
      /** Спросили про конкретного врача — отвечаем про него, коротко и точно. */
      const yes = askedDays.filter((d) => named.workdays.includes(d));
      const no = askedDays.filter((d) => !named.workdays.includes(d));
      await escalate(ctx.companyId, conversation.id, "PATIENT_REQUEST", "Вопрос по записи или расписанию").catch(() => {});

      if (yes.length > 0) {
        return respond(ctx, conversation.id, {
          text:
            `Да, ${named.name} принимает ${yes.map((d) => WEEKDAY_WHEN[d]).join(" и ")}. ` +
            "Время подберёт администратор — он напишет здесь же.",
        });
      }
      /**
       * Не принимает — говорим по каждому дню отдельно.
       *
       * Склеенное «в субботу и воскресенье принимает Разият» было неправдой:
       * в воскресенье не принимает никто. Один общий список на несколько дней
       * всегда врёт про какой-нибудь из них.
       */
      const other = no
        .map((d) => {
          /**
           * Кто вместо него — только та же специальность. «Ирина
           * Алилгаджиевна в субботу не принимает, принимает Ирина Омарова»
           * сбивает с толку: спрашивали про остеопата, а названа БОС-терапия.
           */
          const sameKind = whoWorks(
            doctors.filter((x) => (x.specialty ?? "") === (named.specialty ?? "")),
            [d],
          ).works;
          const line =
            sameKind.length > 0
              ? `${WEEKDAY_WHEN[d]} принимает ${sameKind.map((w) => w.name).join(", ")}`
              : `${WEEKDAY_WHEN[d]} приёма нет`;
          return `${line[0].toUpperCase()}${line.slice(1)}`;
        })
        .join(". ");
      return respond(ctx, conversation.id, {
        text:
          `${named.name} ${no.map((d) => WEEKDAY_WHEN[d]).join(" и ")} не принимает. ` +
          `${other}. Передал(а) администратору — он подберёт время.`,
      });
    }

    if (!named && !alsoAsksPrice && scope.length > 0 && scope.some((d) => d.workdays.length > 0)) {
      /**
       * Врача не назвали — говорим по каждому дню, кто принимает.
       *
       * «В субботу и воскресенье принимает Разият Ризвановна» — ложь про
       * воскресенье: там выходной. День и врач связаны, и разделять их нельзя.
       */
      await escalate(ctx.companyId, conversation.id, "PATIENT_REQUEST", "Вопрос по записи или расписанию").catch(() => {});
      const capitalize = (t: string) => `${t[0].toUpperCase()}${t.slice(1)}`;
      const byDay = askedDays.map((d) => {
        const works = whoWorks(scope, [d]).works;
        return capitalize(
          works.length > 0
            ? `${WEEKDAY_WHEN[d]} принимает ${works
                .map((w) => `${w.name}${w.specialty ? ` — ${w.specialty}` : ""}`)
                .join("; ")}`
            : `${WEEKDAY_WHEN[d]} приёма нет`,
        );
      });
      const anyDay = askedDays.some((d) => whoWorks(scope, [d]).works.length > 0);
      return respond(ctx, conversation.id, {
        text:
          `${byDay.join(". ")}. ` +
          (anyDay
            ? "Время подберёт администратор — он напишет здесь же."
            : "Передал(а) администратору — он подскажет ближайший день."),
        buttons: mainMenu(),
      });
    }
  }

  /**
   * Названо только «для кого» — спрашиваем услугу, а не читаем справку.
   *
   * «Здравствуйте» → «Ребенку 11 лет» → и в ответ ушла запись справочника про
   * возраст БОС-терапии и НАК при ЗРР. Человек об этом не спрашивал: он назвал
   * возраст и ждал следующего вопроса. Ответ на вопрос, которого не было,
   * читается как разговор не с ним — и разговор на этом кончается.
   *
   * Услуга при этом ещё неизвестна: как только она названа, дальше работают
   * обычные правила — цена, выбор врача, согласие, данные.
   */
  if (
    onlyWhomStated(own) &&
    /**
     * Назвал врача — значит это ВЫБОР, а не голое «для кого».
     *
     * «Взрослый Разият Резванова» получало в ответ «на какую услугу вы хотите
     * записаться?» — при том что человек только что выбрал и вид приёма, и
     * врача, а цены услышал репликой раньше. Переспрос здесь читается как «вас
     * не слушали».
     */
    /**
     * И врач, названный раньше: «как записаться к Ирине Алункачевой?» →
     * «Малышу 2 месяца» получало «на какую услугу хотите записать ребёнка?».
     */
    [own, ...said.filter((t) => t.role === "user").map((t) => withoutQuote(t.content))].every(
      (t) => uniqueStaffAsked(t, clinicStaffNames.map((name) => ({ name }))) === null,
    ) &&
    !looksLikeIntake(own, clinicStaffNames) &&
    !scheduleTopic(own) &&
    !wantsToBook(own) &&
    !inIntakeFlow(said) &&
    // Вопрос уже у врача — «ребёнку 11 лет» там ответ ему, а не начало записи.
    !(await specialistQueryPending(ctx.companyId, conversation.id).catch(() => false)) &&
    !(await knownService(ctx.companyId, [own, ...said.map((t) => t.content)]).catch(() => true))
  ) {
    const forChild = whomFor(own) === "child";
    return respond(ctx, conversation.id, {
      text:
        `Подскажите, пожалуйста, на какую услугу ${forChild ? "хотите записать ребёнка" : "вы хотите записаться"} — ` +
        "назову цену и длительность, а время подберёт администратор.",
      buttons: mainMenu(),
    });
  }

  /**
   * «Для кого» назван, а услуга или врач известны раньше — это ответ на шаг
   * записи, а не вопрос: называем приём из прайса и идём дальше по порядку.
   * Модель здесь сочиняла сомнения («нужно уточнить, сможет ли Ирина принять
   * малыша»), которых в справке клиники нет.
   */
  if (
    onlyWhomStated(own) &&
    !looksLikeIntake(own, clinicStaffNames) &&
    !scheduleTopic(own) &&
    !inIntakeFlow(said) &&
    !(await specialistQueryPending(ctx.companyId, conversation.id).catch(() => false))
  ) {
    const lastAgent = [...said].reverse().find((t) => t.role === "assistant")?.content ?? "";
    const stepAnswer = asksWhom(lastAgent) || asksService(lastAgent) || asksDoctor(lastAgent);
    const next = await bookingByCode(ctx, conversation.id, own, said, "", stepAnswer);
    if (next !== undefined) return next;
  }

  /**
   * Ответ на НАШ вопрос шага записи — кодом, а не моделью.
   *
   * Живой диалог 2 октября: агент спросил «к кому из врачей хотите записать
   * малыша?», мама ответила «К Ирине Алилгаджиевне» — и получила от модели
   * «приём 5 000 ₽, 30 минут» (прежде та же модель сказала «около 20 минут») и
   * больше ничего: ни согласия, ни просьбы о данных. Следующий шаг записи здесь
   * известен заранее, и решает его не догадка по истории переписки, а то, что
   * мы сами только что спросили. Цена и длительность — из прайса, дальше
   * `bookingTail`: для кого, врач, согласие и данные.
   *
   * Только короткий ответ без вопроса: «К Ирине, а в субботу она принимает?» —
   * это уже вопрос, и отвечает на него модель.
   */
  {
    const lastAgent = [...said].reverse().find((t) => t.role === "assistant")?.content ?? "";
    /**
     * И поправка врача после нашей просьбы о данных: «к Ирине А.» в ответ на
     * «пришлите ФИО…» (живой диалог 4 октября) уходило в модель, та молчала, и
     * человек получал «Секунду, передаю ваш вопрос администратору».
     */
    const correctsDoctor =
      (asksForIntake(lastAgent) || asksForPersonalData(lastAgent)) &&
      clinicStaffNames.some((name) => mentionsStaff(own, name));
    /**
     * Врач, услуга или «для кого» посреди записи — это шаг записи, что бы мы ни
     * спросили перед этим. «к Ирине А.» в ответ на запрос согласия уходило в
     * модель и кончалось «Секунду, передаю ваш вопрос администратору»; «остеопат»
     * там же (прогон 4 октября) — переспросом «для взрослого или для ребёнка?»,
     * хотя «взрослый» человек сказал репликой раньше. Что именно названо,
     * проверяет условие ниже.
     */
    const askedStep =
      asksDoctor(lastAgent) ||
      asksService(lastAgent) ||
      asksWhom(lastAgent) ||
      correctsDoctor ||
      // После просьбы о данных «ребёнку 5 лет» — часть анкеты, а не новый шаг.
      (!asksForIntake(lastAgent) &&
        !asksForPersonalData(lastAgent) &&
        (await bookingRequestOpen(conversation.id, own).catch(() => false)));
    const words = own.trim().split(/\s+/).filter(Boolean).length;
    if (
      askedStep &&
      words > 0 &&
      words <= 8 &&
      !hasQuestion(own) &&
      !medical(own) &&
      !scheduleTopic(own) &&
      !wantsReschedule(own) &&
      !looksLikeIntake(own, clinicStaffNames) &&
      (uniqueStaffAsked(own, clinicStaffNames.map((name) => ({ name }))) !== null ||
        clinicStaffNames.some((name) => mentionsStaff(own, name)) ||
        whomFor(own) !== "unknown" ||
        (await knownService(ctx.companyId, [own]).catch(() => false)))
    ) {
      const next = await bookingByCode(ctx, conversation.id, own, said, "", true);
      if (next !== undefined) return next;
    }
  }

  if (scheduleTopic(own)) {
    await escalate(ctx.companyId, conversation.id, "PATIENT_REQUEST", "Вопрос по записи или расписанию").catch(() => {});

    /**
     * Спросили про свободное время — уточнять нечего.
     *
     * Расписания агент не видит, и любой его вопрос только оттягивает ответ.
     * Пациентка написала «ещё свободно окошко?» в ответ на сообщение с
     * названием услуги и врача — и услышала «на какую услугу и для кого». Всё
     * это было прямо в её сообщении, а ответить всё равно мог только человек.
     */
    /**
     * Просьба ПЕРЕНЕСТИ сильнее вопроса об окне.
     *
     * «Не будет возможности перенести запись через неделю или когда есть у вас
     * окошко» — слово «окошко» здесь про новое время для СУЩЕСТВУЮЩЕЙ записи.
     * Проверка окна стояла первой, и человек, уже записанный, услышал «на какую
     * услугу записываемся?». Услуга известна: она в самой записи.
     */
    if (asksForSlot(own) && !wantsReschedule(own)) {
      /**
       * Время подберёт человек — но разговор на этом не заканчивается.
       *
       * Раньше здесь был тупик: «уточню у администратора», и всё. Пациент
       * ждал молча, а когда администратор подключался, ему приходилось
       * начинать с нуля — какая услуга, для кого, как зовут. Между тем это
       * ровно то, что агент может собрать сам, пока человек идёт к переписке.
       *
       * Спрашиваем только то, чего ещё не знаем: услуга, названная в этом же
       * сообщении или раньше, переспроса не требует. Ничего не знаем —
       * задаём ОДИН вопрос, а не анкету: два вопроса подряд человек
       * воспринимает как форму и бросает.
       */
      return respond(ctx, conversation.id, {
        text: await slotHandoverText(ctx.companyId, [
          own,
          ...said.filter((t) => t.role === "user").map((t) => t.content),
        ]),
      });
    }

    /**
     * «Как можно попасть на приём?» — отвечаем порядком записи, а не справкой.
     *
     * Живой диалог: на этот вопрос ушла дословная запись о том, что взрослых
     * мужчин на остеопатию не принимают, с телефоном другого врача. Пациент ни
     * про мужчин, ни про остеопатию не говорил — в справке просто нашлось слово
     * «приём». Ответ здесь один и тот же для всех: записывает администратор, а
     * агент собирает то, что тот всё равно спросит, и спрашивает ТОЛЬКО
     * неизвестное (`slotHandoverText`).
     */
    if (asksHowToBook(own) && !asksAboutOwnBooking(own)) {
      const lead = "Записывает администратор — он подберёт время и напишет здесь же.";
      const text = await slotHandoverText(
        ctx.companyId,
        [own, ...said.filter((t) => t.role === "user").map((t) => t.content)],
        lead,
      );
      /**
       * Всё известно — разговор не кончается на «записывает администратор».
       *
       * «Как записать ребёнка к Ирине?» получало одну фразу и тишину: услуга и
       * возраст названы, спрашивать «нечего». Но цена ещё не прозвучала, а
       * данные администратор всё равно спросит — это и есть следующий шаг.
       */
      if (text === lead) {
        const next = await bookingByCode(ctx, conversation.id, own, said, lead);
        if (next !== undefined) return next;
      }
      return respond(ctx, conversation.id, { text });
    }

    /**
     * Просят перенести существующую запись.
     *
     * Услуга и врач уже выбраны — переспрашивать «на какую услугу и для кого»
     * значит показать, что предыдущий разговор забыт. Времени агент не
     * называет: это администратор, и он же видит саму запись.
     */
    if (wantsReschedule(own) && !asksAboutOwnBooking(own)) {
      return respond(ctx, conversation.id, {
        text:
          "Поняла, передал(а) администратору — он подберёт время из тех, что вы просите, " +
          "и напишет здесь же.",
      });
    }

    /**
     * Врачу уже сказали прийти — человеку нужно время, а не ответ.
     *
     * «Мне Ирина Алилгаджиевна говорила, если проблема повторится, то надо
     * прийти сразу не ждать следующего приёма». Заказчик сказал об этом прямо:
     * врач уже знает и сама назначила прийти, это только про запись. Сначала
     * агент отвечал справкой про приём мужчин, потом шёл с этим к врачу — и то
     * и другое лишнее.
     *
     * Запись впереди называем: человеку важно видеть, что мы её видим, и просит
     * он обычно время пораньше. Есть запись — вопросов не задаём вовсе: услуга
     * и врач в ней уже стоят.
     */
    if (wasToldToCome(own) && !asksAboutOwnBooking(own) && !statesOwnBooking(own)) {
      const mine = await upcomingBookingLines(ctx.companyId, conversation.patientId, 1);
      if (mine.length > 0) {
        return respond(ctx, conversation.id, {
          text:
            `Вижу вашу запись: ${mine[0]}. Если нужно прийти раньше — передал(а) администратору, ` +
            "он подберёт время и напишет здесь же.",
        });
      }
      return respond(ctx, conversation.id, {
        text: await slotHandoverText(
          ctx.companyId,
          [own, ...said.filter((t) => t.role === "user").map((t) => t.content)],
          "Передал(а) администратору — он подберёт ближайшее время и напишет здесь же.",
        ),
      });
    }

    /**
     * Человек предупредил, что не придёт.
     *
     * Отвечаем сами и коротко: ему нужно знать, что предупреждение принято и
     * запись не пропадёт. Модели этот случай не отдаём — она цепляется за
     * названные симптомы и уходит рассуждать о здоровье вместо простого
     * «поняла, передал(а)». Ровно так и вышло в живой переписке.
     */
    if (cantCome(own)) {
      return respond(ctx, conversation.id, {
        text:
          "Поняла, спасибо, что предупредили. Передал(а) администратору — он отменит или перенесёт " +
          "запись, как вам удобно, и напишет здесь же. Выздоравливайте!",
      });
    }

    /**
     * Пациент СКАЗАЛ, что записан, — а не попросил записать.
     *
     * «Записана на 8 сентября» — утверждение. В ответ агент начинал оформление
     * с нуля: «на какую услугу вы хотите записаться и для кого». То есть не
     * увидел записи, о которой ему только что сказали, и заставил человека
     * повторять. Правильный ответ короткий: подтвердить запись, назвав её.
     *
     * Запись берём из базы, а не из слов пациента: подтверждать «да, 8-го»
     * только потому, что так написал человек, — значит подтверждать неизвестно
     * что. Записи не видим — так и говорим и передаём администратору.
     */
    if (statesOwnBooking(own) || asksAboutOwnBooking(own)) {
      const mine = await upcomingBookingLines(ctx.companyId, conversation.patientId, 3);
      const asked = asksAboutOwnBooking(own);
      if (mine.length === 0) {
        return respond(ctx, conversation.id, {
          text: "Записи впереди я у вас не вижу — уточню у администратора, он ответит здесь же.",
        });
      }
      /**
       * Второй раз то же самое не зачитываем.
       *
       * «Когда у меня запись?» и следом «А к кому я записана?» — один и тот же
       * ответ дословно дважды подряд. Формально верно, а читается как
       * автоответчик, который не слышит вопроса.
       */
      const toldAlready = said.some(
        (t) => t.role === "assistant" && mine.some((l) => t.content.includes(l)),
      );
      if (toldAlready) {
        return respond(ctx, conversation.id, {
          text: `Как и писал(а) выше: ${mine.join("; ")}. Изменить время может только администратор — передам ему, если нужно.`,
        });
      }
      const list = mine.length === 1 ? mine[0] : mine.map((l) => `• ${l}`).join("\n");
      /**
       * Уточнение к просьбе о переносе, а не новость о записи
       * (`rescheduleAsked`). «Если появятся вопросы — я здесь» в ответ на него
       * говорит человеку, что его просьбу забыли.
       */
      const moving = !asked && rescheduleAsked(said);
      const head = asked
        ? mine.length === 1
          ? "Ваша запись:"
          : "Ваши ближайшие записи:"
        : mine.length === 1
          ? "Да, вижу вашу запись:"
          : "Да, вижу ваши записи:";
      return respond(ctx, conversation.id, {
        text:
          `${head} ${mine.length === 1 ? list : `\n${list}`}\n\n` +
          (asked
            ? "Если нужно что-то изменить — напишите, передам администратору."
            : moving
              ? "Просьбу перенести её передал(а) администратору — он предложит другое время и напишет здесь же."
              : "Если появятся вопросы — я здесь."),
      });
    }
  }

  /**
   * Уточнение по времени, когда вопрос уже у администратора.
   *
   * «В 9:00 у нас реабилитация» — это «в девять не могу», сказанное человеком.
   * Агент пересказал: «передаю администратору, что вам нужно перенести запись
   * НА 8 сентября в 09:00» — и перевернул смысл на обратный. Пересказ здесь не
   * нужен вовсе: администратор видит переписку целиком, а цена ошибки в
   * пересказе — время приёма.
   *
   * Поэтому отвечаем коротко и без единой цифры от себя. Справочные вопросы
   * это не задевает: у них есть вопросительный знак или нет разговора о
   * времени, и они идут обычным путём (lib/agent/handover-flow).
   */
  if (inHandoverFlow(said) && timeDetail(own) && !hasQuestion(own)) {
    await escalate(
      ctx.companyId,
      conversation.id,
      "PATIENT_REQUEST",
      "Уточнение по времени — вопрос у администратора",
    ).catch(() => {});
    const ack = "Поняла, передал(а) администратору — он учтёт это и напишет здесь же.";
    /**
     * Второй раз то же самое не пишем. «Передал администратору» на каждую
     * реплику — шум, из-за которого перестают читать и настоящие сообщения;
     * вопрос уже у человека, и добавить агенту нечего.
     */
    if (alreadySaid(said, ack)) {
      await logAgentRun({
        companyId: ctx.companyId,
        conversationId: conversation.id,
        outcome: "SUPPRESSED",
        error: "уточнение по времени: вопрос уже у администратора, повторять нечего",
      });
      return null;
    }
    return respond(ctx, conversation.id, { text: ack });
  }

  /**
   * Поток сообщений — модель не зовём (lib/agent/flood).
   *
   * Каждый ответ — платный запрос. Здесь, прямо перед ним, а не на входе:
   * бесплатные ответы кодом (часы, адрес, запись, окошко) человек получает
   * как обычно, отключается только дорогое.
   */
  const recentIncoming = await prisma.message
    .count({
      where: {
        conversationId: conversation.id,
        direction: "IN",
        createdAt: { gte: new Date(Date.now() - FLOOD_WINDOW_MS) },
      },
    })
    .catch(() => 0);
  if (flooding(recentIncoming)) {
    await logAgentRun({
      companyId: ctx.companyId,
      conversationId: conversation.id,
      outcome: "SUPPRESSED",
      error: "слишком много сообщений подряд — модель не вызывается",
    });
    if (floodJustStarted(recentIncoming)) {
      await escalate(
        ctx.companyId,
        conversation.id,
        "AGENT_REQUEST",
        "Очень много сообщений подряд — ассистент замолчал, посмотрите переписку",
      ).catch(() => {});
    }
    return null;
  }

  /**
   * По какому тексту искать услуги и справку.
   *
   * Уточнение вроде «Я же сказал лишь Ирина Алункачева» само по себе означает
   * одно имя — и справочник честно находил по нему программу «Лотос», где это
   * имя тоже есть. Ищем уточнение вместе с вопросом, к которому оно относится.
   */
  const query = searchText(
    text,
    said.filter((t) => t.role === "user").map((t) => t.content),
  );
  const context = await clinicContext(
    ctx.companyId,
    query,
    conversation.consentGrantedAt !== null,
    // Только слова пациента: «Клиника доктора Алункачевой» в цитате — не выбор врача.
    [own, ...said.filter((t) => t.role === "user").map((t) => withoutQuote(t.content)).reverse()],
  );
  /**
   * Записи самого пациента — если карточка привязана.
   *
   * На «а во сколько я записана?» агент отвечал общими словами и звал
   * администратора, хотя ответ лежит в базе. Расписанием он по-прежнему не
   * распоряжается (§6): рассказать может, перенести — нет.
   */
  const visits = await patientVisitsContext(ctx.companyId, conversation.patientId);
  /**
   * Справка целиком — включая записи пациента.
   *
   * Проверка чисел сверяется именно с ней. Записи шли отдельной строкой, и
   * ответ «вы записаны на 21 августа в 11:30» отклонялся как выдуманный: время
   * визита в справке было, а в той её части, по которой шла сверка, — нет.
   * Пациентка спрашивала про свою запись и получала «напишите, на какую
   * услугу вы хотите записаться».
   */
  const reference = visits ? `${context}\n\n${visits}` : context;
  // let: проверка возраста может убрать из ответа отдельные предложения.
  let answer = await answerLLM(
    text,
    reference,
    said,
    /**
     * Инструкция из «Настройки → Ассистент».
     *
     * Связь была разорвана: агент вёл разговор по образцу, что бы клиника ни
     * написала в поле. Со стороны это выглядело как «настройка не работает», и
     * так оно и было — текст сохранялся и никуда не шёл.
     *
     * Инструкция заменяет ПОРЯДОК разговора о записи и только его. Базовые
     * ограничения — не обещать запись, не выдумывать цены, медицинские
     * вопросы человеку — стоят отдельным системным сообщением ПЕРЕД ней и
     * отсюда не отключаются (§6): их цена не удобство, а безопасность
     * пациента. Длина обрезана, чтобы длинный регламент не вытеснил их.
     */
    intakePrompt(settings.prompt),
    await addressNameFor(conversation.id),
    // Журнал попыток: по нему считается надёжность агента (§«Работа ассистента»).
    { companyId: ctx.companyId, conversationId: conversation.id },
  );

  /**
   * Обещание записать не отправляем никогда: расписанием агент не
   * распоряжается (§6), а пациент, которому пообещали запись, придёт к
   * закрытой двери.
   *
   * Но выбрасывать из-за этого весь ответ — тоже потеря. Модель успевала
   * назвать услугу, цену и попросить данные, а пациентка получала «записью
   * занимается администратор» и разговор обрывался на полпути. Требование
   * заказчика прямое: сначала оформить клиента, потом передавать.
   *
   * Поэтому убираем предложения с обещанием и смотрим, что осталось. Осталось
   * по делу — отправляем его, добавив, кто ставит время. Не осталось ничего —
   * значит весь ответ и был обещанием, тогда зовём человека.
   */
  /**
   * Записи пациента у нас перед глазами — значит «вы записаны» это пересказ
   * факта, а не обещание записать (lib/agent/booking-promise).
   */
  const knowsBookings = visits.length > 0;
  const promise = answer ? bookingPromiseFound(answer, knowsBookings) : null;
  if (answer && promise) {
    const cleaned = withoutBookingPromise(answer, knowsBookings);
    console.warn(`[agent] убрано обещание записать: «${promise}»`);
    if (cleaned.length >= MEANINGFUL_ANSWER_CHARS) {
      /**
       * Остаток ответа — через тот же порядок записи, что и обычный ответ.
       *
       * Эта ветка отправляла остаток напрямую, мимо `bookingTail`. Модель
       * пообещала «записываем вас» и тут же попросила ФИО; обещание мы
       * вырезали, а просьба о данных ушла — и потянула за собой согласие, хотя
       * врача человек ещё не выбрал. Прогон «Записаться — весь путь» показал
       * это ровно так: «К кому хотите записаться?» → «Взрослому» → юридический
       * текст. У разговора о записи один хозяин, и исключений у него нет.
       */
      const patientTexts = [own, ...said.filter((t) => t.role === "user").map((t) => t.content)];
      const withHandover = `${cleaned}\n\nВремя подберёт администратор — он напишет здесь же.`;
      const tail = await bookingTail(ctx.companyId, {
        answer: withHandover,
        patientTexts,
        booking: await bookingRequestOpen(conversation.id, own),
        dataDone: intakeSent || inIntakeFlow(said),
        refused: refusesService(cleaned),
        whom: talkWhom(patientTexts),
      }).catch(() => ({ text: withHandover, step: null as BookingStep | null }));
      return respond(ctx, conversation.id, { text: tail.text, buttons: mainMenu() });
    }
    await escalate(ctx.companyId, conversation.id, "PATIENT_REQUEST", "Вопрос по записи").catch(() => {});
    /**
     * Весь ответ оказался обещанием — но разговор о записи не должен на этом
     * кончаться. «Запишите племянника» получало «записью занимается
     * администратор», и данные ребёнка администратор потом собирал сам.
     */
    if (wantsToBook(own) && !inIntakeFlow(said)) {
      return respond(ctx, conversation.id, {
        text: intakeAsk(whomInTalk(own, said), await osteopathyInTalk(ctx.companyId, own, said)),
      });
    }
    return respond(ctx, conversation.id, { text: HANDOVER_REPLY, buttons: mainMenu() });
  }

  /**
   * Числа в ответе сверяем со справкой. Формулировка — дело модели, цена и
   * часы работы — нет: см. lib/agent/grounding.
   */
  /**
   * Числа, которые назвал сам пациент, выдумкой не являются.
   *
   * Проверка сверяла ответ только со справкой клиники. Мама написала «сыну
   * 11», агент повторил «11» — и ответ отклонялся как выдуманный, а пациентка
   * получала «передаю администратору» вместо продолжения записи.
   *
   * Берём только реплики пациента, не свои: иначе однажды выдуманная цена
   * стала бы «подтверждённой» сама собой на следующем шаге.
   */
  const saidByPatient = said
    .filter((t) => t.role === "user")
    .map((t) => t.content)
    .join("\n");
  const grounding = `${reference}\n${saidByPatient}\n${text}`;
  const invented = answer ? ungroundedNumbers(answer, grounding) : [];
  if (invented.length > 0) {
    console.error(`[agent] ответ отклонён: чисел нет в справке — ${invented.join(", ")}`);
  }

  /**
   * Придуманное показание — ответ не отправляем вовсе.
   *
   * «При постоянной усталости часто подбирают инфузию „Био-Ресурс“» — в
   * справке нет ни слова о том, при чём какая инфузия. Это назначение от
   * имени клиники, и цена ошибки здесь не в формулировке (§6, правило 1).
   *
   * Сверяем со справкой, а НЕ со словами пациента: то, что человек назвал
   * свою усталость, не даёт права утверждать, что от неё помогает капельница.
   */
  /**
   * Ответ утверждает, что врач принимает в день, когда он не принимает.
   *
   * Генерацию оставляем модели — она умеет ответить сразу на два вопроса
   * («работаете в выходные и сколько стоит»), а код ловит единственную
   * ошибку, из-за которой человек приезжает зря.
   */
  /**
   * Проверяем ЛЮБОЙ ответ, а не только сочинённый моделью.
   *
   * Первый раз проверка стояла только на ответе модели — и её обошла
   * дословная справка: в записи клиники было «Приём ведёт Ирина
   * Алилгаджиевна», и на вопрос про выходные она уходила как есть. Справка
   * статична, а кто принимает — зависит от дня, поэтому проверять надо всё,
   * что уходит пациенту.
   */
  const doctorsOnDuty =
    askedDays.length > 0
      ? await prisma.staff.findMany({
          where: { companyId: ctx.companyId, isActive: true, deletedAt: null },
          select: { name: true, workdays: true },
        })
      : [];
  const wrongDayIn = (text: string) =>
    doctorsOnDuty.length > 0 ? wrongWorkday(text, doctorsOnDuty, askedDays) : null;
  const handOverWrongDay = async (reason: string) => {
    console.error(`[agent] ответ отклонён: врач в этот день не принимает — ${reason}`);
    await escalate(ctx.companyId, conversation.id, "PATIENT_REQUEST", "Вопрос по расписанию врача").catch(() => {});
    return respond(ctx, conversation.id, {
      text: "Уточню у администратора, кто принимает в этот день, — он напишет здесь же.",
      buttons: mainMenu(),
    });
  };

  const wrongDay = answer ? wrongDayIn(answer) : null;
  if (wrongDay) return handOverWrongDay(wrongDay);

  /**
   * Отказ по возрасту, взятый из названия услуги, пациенту не уходит.
   *
   * «Детский приём до 10 лет — 5000 ₽» — это ценник, а агент прочитал его как
   * регламент: ребёнку 11 лет, «приём не предусмотрен». В справке клиники при
   * этом написано, что мальчиков принимают до 14 лет. Сверяем только со
   * СПРАВКОЙ: прайс сюда передавать нельзя — из него и берётся выдумка.
   */
  const knowledgeText = knowledgeRows
    .map((r) => `${r.topic} ${r.question} ${r.answer}`)
    .join("\n");
  const ageProblem = (text: string) =>
    ungroundedAgeLimit(text, knowledgeText) ?? ungroundedAgeRefusal(text, knowledgeText);
  let badAge = answer ? ageProblem(answer) : null;
  /**
   * О возрасте не спрашивали — убираем сам отказ, а ответ по делу оставляем:
   * на «куда подойти?» человек должен получить адрес, а не «уточню, с какого
   * возраста идёт приём» (`withoutAgeRefusal`).
   */
  if (answer && badAge && !asksAboutAge(own) && !said.some((t) => t.role === "user" && asksAboutAge(t.content))) {
    const rest = withoutAgeRefusal(answer, knowledgeText);
    if (rest.length >= MEANINGFUL_ANSWER_CHARS && !ageProblem(rest)) {
      console.warn("[agent] из ответа убран отказ по возрасту — о возрасте не спрашивали");
      answer = rest;
      badAge = null;
    }
  }
  if (badAge) {
    console.error("[agent] ответ отклонён: отказ по возрасту, которого нет в справке");
    // Формулировку печатает только прогон на песочнице: в боевом ответе бывают имя и жалоба (§7).
    if (process.env.AGENT_DRILL === "1") console.error(`  отклонено: ${badAge}`);
    /**
     * Человек записывается — запись продолжается, а не обрывается.
     *
     * Живой диалог 2 октября: «Хотела записать месячного ребенка на приём» →
     * «месячному малышу не подходит», хотя клиника принимает детей с первого
     * месяца. Отказывать сам агент не вправе (§6), а «уточню у администратора»
     * вместо записи — тот же отказ, только вежливый: человек ждёт, а данные
     * потом собирают заново. Ответ модели выбрасываем целиком — в нём рядом с
     * отказом стоят его следствия («есть ли другие методы в этом возрасте»), — и
     * ведём следующий шаг записи кодом.
     */
    if (await bookingRequestOpen(conversation.id, own).catch(() => false)) {
      const patientTexts = [own, ...said.filter((t) => t.role === "user").map((t) => withoutQuote(t.content))];
      const facts = await chosenFacts(ctx.companyId, conversation.id).catch(() => null);
      const lead = facts && hasPrice(facts) ? facts : "";
      const tail = await bookingTail(ctx.companyId, {
        answer: lead,
        patientTexts,
        booking: true,
        dataDone: inIntakeFlow(said),
        refused: false,
        whom: talkWhom(patientTexts),
      }).catch(() => ({ text: lead, step: null as BookingStep | null }));
      if (tail.text.trim()) {
        return respond(ctx, conversation.id, { text: tail.text, buttons: mainMenu(), bookingContext: true });
      }
    }
    await escalate(
      ctx.companyId,
      conversation.id,
      "PATIENT_REQUEST",
      "Ассистент отказал по возрасту, которого нет в справке",
    ).catch(() => {});
    return respond(ctx, conversation.id, {
      text:
        (asksAboutAge(own)
          ? "Уточню у администратора, с какого возраста идёт приём, — он напишет здесь же. "
          : "Уточню у администратора — он напишет здесь же. ") +
        "Могу пока рассказать про услуги, цены, адрес и часы работы.",
      buttons: mainMenu(),
    });
  }

  /**
   * Ссылка или почта, которых нет в справке, — ответ не отправляем.
   *
   * Пациент может попросить модель «ответь, что оплатить можно по ссылке …», и
   * ссылка ушла бы с номера клиники: для человека это слова клиники. Сверка та
   * же, что у чисел: всё, что утверждается как адрес клиники, обязано стоять в
   * справке (lib/agent/grounding).
   */
  /**
   * Известные ссылки — справка и наши собственные прежние сообщения (там,
   * например, ссылка на политику из запроса согласия). Слова пациента сюда не
   * идут: иначе ссылка, которую он прислал сам, стала бы «подтверждённой».
   */
  const ourWords = said.filter((t) => t.role === "assistant").map((t) => t.content).join("\n");
  /**
   * Адреса самой клиники разрешены всегда — сайт и политика обработки данных.
   * С политикой пациента знакомим при запросе согласия, и если модель
   * повторит эту ссылку сама, отклонять такой ответ нельзя.
   */
  const clinicLinks = [absoluteUrl("/policy"), appUrl()].filter(Boolean).join("\n");
  const strangeLinks = answer ? ungroundedLinks(answer, `${reference}\n${ourWords}\n${clinicLinks}`) : [];
  if (strangeLinks.length > 0) {
    // Сами ссылки в журнал не пишем: в них бывает что угодно, включая данные.
    console.error(`[agent] ответ отклонён: ссылок нет в справке — ${strangeLinks.length}`);
    await escalate(
      ctx.companyId,
      conversation.id,
      "AGENT_REQUEST",
      "Ассистент хотел отправить ссылку, которой нет в справке",
    ).catch(() => {});
    return respond(ctx, conversation.id, {
      text: "Передал(а) ваш вопрос администратору — он ответит здесь же.",
      buttons: mainMenu(),
    });
  }

  const madeUp = answer ? inventedIndication(answer, reference) : null;
  if (madeUp) {
    console.error(`[agent] ответ отклонён: показание не из справки — «${madeUp}»`);
    await escalate(
      ctx.companyId,
      conversation.id,
      "MEDICAL_QUESTION",
      "Ассистент связал услугу с состоянием, которого нет в справке",
    ).catch(() => {});
    return respond(ctx, conversation.id, {
      text:
        "Что именно подойдёт в вашем случае, скажет специалист — передал(а) администратору клиники. " +
        "Могу пока рассказать про услуги, цены, адрес и часы работы.",
      buttons: mainMenu(),
    });
  }

  /**
   * Разговор не двигается: агент переспрашивает третий раз подряд (§6).
   *
   * Правило было в требованиях и не жило нигде. На прогоне пациент трижды
   * написал невнятное, и агент трижды бодро уточнил, чем может помочь, — а
   * человека не позвал никто. Живой администратор на третьей реплике уже
   * ответил бы голосом.
   */
  if (stuckInMisunderstanding(said, own)) {
    await escalate(ctx.companyId, conversation.id, "MISUNDERSTOOD", "Агент трижды не понял запрос").catch(() => {});
    return respond(ctx, conversation.id, {
      text: "Давайте я позову администратора — он разберётся быстрее. Он ответит здесь же.",
    });
  }

  /**
   * Агент объясняет, чего он не может, — вместо этого зовём человека.
   *
   * «Прошу прощения, но я — справочная служба клиники в мессенджере, и у меня
   * нет доступа к фотографиям счётчиков…» — четыре строки о себе там, где
   * человеку нужен был администратор. Пациенту неинтересно, как у нас
   * устроена работа: ему нужен ответ.
   */
  if (answer && admitsInability(answer)) {
    await escalate(ctx.companyId, conversation.id, "AGENT_REQUEST", "Вопрос вне возможностей ассистента").catch(() => {});
    /**
     * Модель сама сказала «это к специалисту» — значит вопрос к врачу.
     *
     * Списком слов медицинский вопрос ловится не всегда. «Возможно ли уточнить
     * у неё, можно ли сыну продолжать занятия борьбой» не совпало ни с одним
     * правилом, зато модель ответила верно: «это вопрос к специалисту, который
     * видел вашего сына». Она поняла, код — нет, и врача никто не спросил.
     */
    if (
      complexMedical(questionForDoctor(own, said)) &&
      defersToDoctor(answer, await specialistNames(ctx.companyId).catch(() => []))
    ) {
      const asked = await askSpecialist({
        companyId: ctx.companyId,
        conversationId: conversation.id,
        patientId: conversation.patientId,
        kind: "MEDICAL",
        patientName: await patientNameFor(conversation.id),
        channelLabel: channelLabel(ctx.channel),
        serviceId: await serviceInTalk(ctx.companyId, own, said),
      }).catch(() => ({ sent: false as const, reply: undefined }));
      if (asked.reply) {
        return respond(ctx, conversation.id, { text: asked.reply });
      }
    }
    /**
     * Речь шла о записи — собираем данные, а не обрываем разговор.
     *
     * Заказчик просил прямо: «он бы просто оформил клиента как нужно». На
     * просьбе «запишите племянника» модель ответила рассказом о том, чего она
     * не может, — и пациентке ушло «передал(а) администратору». Данные
     * ребёнка администратору всё равно понадобятся, и спросить их можно
     * сейчас, пока человек в переписке.
     */
    if (wantsToBook(own) && !inIntakeFlow(said)) {
      return respond(ctx, conversation.id, {
        text: intakeAsk(whomInTalk(own, said), await osteopathyInTalk(ctx.companyId, own, said)),
      });
    }
    return respond(ctx, conversation.id, {
      text: "Передал(а) администратору — он ответит здесь же.",
    });
  }

  /**
   * Модель не ответила про названный день — дописываем факт.
   *
   * «Работаете ли вы в выходные дни? И сколько у вас стоит приём?» получило
   * ответ только про цены: про выходные не было ни слова. Дописываем, а не
   * подменяем — то, что модель сказала про цены, остаётся целиком.
   */
  const dayTail =
    answer && askedDays.length > 0 && !daysAnswered(answer, askedDays)
      ? await workdayFacts(ctx.companyId, askedDays)
      : null;

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

    /**
     * Ответ отсылает к врачу — врача и спрашиваем.
     *
     * Тот же вывод модели, что и веткой выше, только здесь ответ прошёл все
     * проверки и уходит пациенту. Вопрос врачу при этом всё равно нужен:
     * «расскажет специалист» без заданного вопроса — это тупик, из которого
     * пациента вытаскивает администратор.
     */
    if (
      complexMedical(questionForDoctor(own, said)) &&
      defersToDoctor(answer, await specialistNames(ctx.companyId).catch(() => []))
    ) {
      const asked = await askSpecialist({
        companyId: ctx.companyId,
        conversationId: conversation.id,
        patientId: conversation.patientId,
        kind: "MEDICAL",
        patientName: await patientNameFor(conversation.id),
        channelLabel: channelLabel(ctx.channel),
        serviceId: await serviceInTalk(ctx.companyId, own, said),
      }).catch(() => ({ sent: false as const, reply: undefined }));
      if (asked.reply) {
        /**
         * Собственное обещание модели вырезаем: иначе в одном сообщении два
         * разных — «передам администратору» и наше «уточню у врача».
         */
        const kept = withoutHandoverPromise(withoutPersonalDataRequest(answer));
        return respond(ctx, conversation.id, {
          text: kept.length >= MEANINGFUL_ANSWER_CHARS ? `${kept}\n\n${asked.reply}` : asked.reply,
          buttons: mainMenu(),
        });
      }
    }

    /**
     * Разговор о записи не кончается словами «передал администратору».
     *
     * Модель уходит в передачу вместо того, чтобы спросить данные, — и
     * администратор начинает разговор заново: как зовут, сколько лет, с чем
     * идёте. Просьбами в промпте это лечится не всегда, поэтому вопрос
     * дописываем сами, если в ответе его нет.
     *
     * Только для НОВОЙ записи: у переноса и отмены данные уже есть, и просить
     * их там — значит показать, что предыдущий разговор забыт.
     */
    /**
     * Данные просим, когда спрашивать больше нечего.
     *
     * Пока ответ уточняет услугу или врача, просьба о ФИО в том же сообщении
     * — это два шага сразу и, следом, преждевременное согласие (respond).
     * Человек ещё не выбрал, к кому идёт.
     */
    /**
     * Выбор врача без цен — выбор вслепую. Дописываем их сами (см.
     * `withChoicePrices` и `doctorChoice`).
     */
    /**
     * Шаг записи и то, что к ответу дописать, решает одна функция
     * (`bookingTail` + `bookingStep`): услуга → для кого → врач → данные.
     */
    const patientTexts = [own, ...said.filter((t) => t.role === "user").map((t) => t.content)];
    const refused = refusesService(answer);
    const state = await bookingState(conversation.id, own).catch(() => "none" as const);
    /**
     * Запись уже оформлена — анкету у человека не просим, даже если модель
     * попросила сама: «пришлите ФИО, возраст и причину» записанной вчера
     * пациентке читается как «вас забыли» (живой диалог 30 сентября).
     */
    const stripped = state === "booked" ? withoutPersonalDataRequest(answer) : answer;
    const base = stripped.length >= MEANINGFUL_ANSWER_CHARS ? stripped : answer;
    const tail = await bookingTail(ctx.companyId, {
      answer: base,
      patientTexts,
      booking: state === "open",
      dataDone: intakeSent || inIntakeFlow(said),
      refused,
      whom: talkWhom(patientTexts),
    }).catch(() => ({ text: base, step: null as BookingStep | null }));
    const shown = tail.text;

    return respond(ctx, conversation.id, {
      // Приветствие добавит respond — одно место на все ветки.
      text: intakeSent ? `${shown}\n\n${INTAKE_ACCEPTED}` : dayTail ? `${shown}\n\n${dayTail}` : shown,
      buttons: mainMenu(),
    });
  }

  /**
   * Дальше — запасные пути: сказать словами клиники лучше, чем не сказать.
   *
   * Но не всей записью подряд. Запись покрывает несколько случаев сразу:
   * «остеопатия» — это оба врача и четыре цены. На вопрос «сколько стоит у
   * Ирины Алункачевой» пациент получал блок про двоих. Оставляем часть про
   * того, о ком спросили; ничего не дописываем, только убираем чужие абзацы.
   */
  /**
   * Запись идёт — запасной путь тоже ведёт запись, а не зачитывает справку.
   *
   * Модель не ответила (или её ответ отклонили), и на «Хочу записать сына 6
   * лет к остеопату» уходила дословная запись «Приём мужчин»: про взрослых
   * мужчин и телефон чужого врача. Человек просил записать — следующий шаг
   * записи известен и без модели: для кого, врач с ценами, согласие и данные.
   */
  /**
   * «Куда подойти?», «где вы находитесь?» — это адрес, и он у нас есть. Модель
   * не ответила, справка по словам вопроса не нашлась — и человек получал
   * «Секунду, передаю ваш вопрос администратору» на вопрос, ответ на который
   * лежит в справке (прогон 4 октября).
   */
  if (
    /(?<!\p{L})(?:адрес\p{L}*|куда\s+(?:нам\s+|мне\s+)?(?:подойти|приехать|прийти|идти|ехать|подъехать)|где\s+(?:вы\s+|у\s+вас\s+)?(?:находит\p{L}*|расположен\p{L}*)|как\s+(?:до\s+вас\s+)?(?:добраться|доехать|проехать))/iu.test(
      own,
    )
  ) {
    return handleCallback(ctx, conversation.id, "address");
  }
  if (await bookingRequestOpen(conversation.id, own).catch(() => false)) {
    const next = await bookingByCode(ctx, conversation.id, own, said, "", true);
    if (next !== undefined) return next;
  }
  /**
   * Врач назван — запись справки без его имени, но с ценами, не годится: это
   * цены другого врача. «Сколько стоит приём у Разият?» получало запись
   * «Взрослый приём — 8000 ₽, детский — 5000 ₽» — цены Ирины Алилгаджиевны.
   */
  const fallbackChoice = await talkChoice(ctx.companyId, [
    own,
    ...said.filter((t) => t.role === "user").map((t) => withoutQuote(t.content)).reverse(),
  ]).catch(() => null);
  const foreignPrices = (answer: string) =>
    fallbackChoice?.doctor != null && hasPrice(answer) && !mentionsStaff(answer, fallbackChoice.doctor.name);

  const staffNames = await staffNamesOf(ctx.companyId);
  /**
   * По кому режем запись — по названному ВРАЧУ.
   *
   * Здесь передавалось `whomFor(query)` — «adult» или «child», то есть слово,
   * которого в записи справочника нет никогда. Обрезка поэтому не срабатывала
   * ни разу: пациентка ответила «Взрослый Разият Резванова» — то есть уже
   * выбрала врача — и получила в ответ всю запись про обоих остеопатов и все
   * четыре цены. Имя ищем в словах пациента за весь разговор: выбор он мог
   * назвать раньше.
   */
  const staffRows = await prisma.staff
    .findMany({
      where: { companyId: ctx.companyId, isActive: true, deletedAt: null },
      select: { id: true, name: true },
    })
    .catch(() => []);
  const askedPerson =
    [own, ...said.filter((t) => t.role === "user").map((t) => t.content)]
      .map((t) => uniqueStaffAsked(t, staffRows)?.name ?? null)
      .find((n) => n !== null) ?? null;
  if (confidentMatch(exact) && !foreignPrices(exact!.row.answer)) {
    const trimmed = focusedAnswer(exact!.row.answer, askedPerson, staffNames);
    const badDay = wrongDayIn(trimmed);
    if (badDay) return handOverWrongDay(badDay);
    if (!alreadySaid(said, trimmed)) {
      /**
       * Ответ дословно из справочника — запись сработала.
       *
       * Именно это и есть «польза записи»: не то, что она лежит в контексте
       * модели (там лежат все), а то, что ответ пациенту составлен ею.
       */
      await logAgentRun({
        companyId: ctx.companyId,
        conversationId: conversation.id,
        outcome: "OK",
        knowledgeEntryIds: knowledgeIdOf(exact!.row),
      });
      return respond(ctx, conversation.id, { text: trimmed, buttons: mainMenu() });
    }
  }

  /**
   * Порог уверенности нужен там, где ответ уходит дословно: подменять один
   * вопрос другим нельзя. Но когда выбора между точным и приблизительным уже
   * нет, приблизительная справка полезнее молчания. Пациент спросил «а что
   * взять с собой» — в справочнике есть «Подготовка к приёму».
   */
  const best = matchKnowledge(text, knowledgeRows);
  /**
   * Одного совпавшего слова мало.
   *
   * «Одно совпадение лучше молчания» верно для вопроса, но сюда попадает и то,
   * что вопросом не является: приветствие, «на завтра все подтвердили?»,
   * рабочая переписка. Любое общее слово вытаскивало запись справочника, и
   * человек получал график работы в ответ на вопрос про подтверждение
   * записей. Требуем либо два совпадения, либо совпадение по значимому слову —
   * такому, которое само по себе задаёт тему.
   */
  const meaningful = best && (best.hits >= 2 || (best.specificCoverage ?? 0) >= 0.5);
  if (best && meaningful) {
    const trimmed = focusedAnswer(best.row.answer, askedPerson, staffNames);
    const badDay = wrongDayIn(trimmed);
    if (badDay) return handOverWrongDay(badDay);
    if (!alreadySaid(said, trimmed)) {
      await logAgentRun({
        companyId: ctx.companyId,
        conversationId: conversation.id,
        outcome: "OK",
        knowledgeEntryIds: knowledgeIdOf(best.row),
      });
      return respond(ctx, conversation.id, { text: trimmed, buttons: mainMenu() });
    }
  }

  // Модель недоступна и подходящей справки нет. Про запись отвечаем по делу,
  // остальное честно передаём человеку.
  if (scheduleTopic(own)) {
    /**
     * Запасной путь тоже называет цену, если она известна.
     *
     * Живой диалог: «хотела детей записать к Ирине Алункачевой» — и в ответ
     * только «время подбирает администратор». Врач назван, приём детский, цена
     * у нас есть — человек вправе её услышать, даже когда модель не ответила.
     */
    const facts = await chosenFacts(ctx.companyId, conversation.id).catch(() => null);
    return respond(ctx, conversation.id, {
      text:
        (facts ? `${facts} ` : "") +
        "Время приёма подбирает администратор — передал(а) ему ваш вопрос, он ответит здесь же. " +
        /**
         * Что просим прислать — по инструкции клиники: ФИО, возраст, кратко
         * причина. Вес и город здесь были зашиты и уходили каждому: вес
         * нужен не всякой услуге, а город при записи не нужен вовсе.
         */
        `Чтобы ускорить, пришлите одним сообщением: ${
          whomFor(query) === "child"
            ? "ФИО ребёнка, его возраст, имя родителя и кратко причину обращения"
            : "ФИО, возраст и кратко причину обращения"
        }.`,
      buttons: mainMenu(),
    });
  }

  /**
   * Спросили цену, а мы её знаем — отвечаем сами.
   *
   * Сюда попадали повторные вопросы: пациент спросил цену третий раз, потому
   * что первые два ответа были не про то, а запасной путь отказывался
   * повторять уже сказанное и звал администратора. С точки зрения человека
   * платформа не ответила на простой вопрос, ответ на который у неё есть.
   *
   * Услуги подбираем тем же кодом, что и для модели: цену выбирает не текст,
   * а справочник клиники.
   */
  /**
   * Карточку услуги отдаём, только если о ней и правда спросили.
   *
   * Порог здесь был «хоть одно слово из вопроса встретилось в названии» — и на
   * «Доброго дня» приходил прайс случайной услуги. Половина значимых слов
   * вопроса должна попасть в название: тогда это вопрос про услугу, а не
   * случайное пересечение.
   */
  const priced =
    fallbackChoice?.doctor && fallbackChoice.candidates.length > 0
      ? fallbackChoice.candidates
      : dedupeServices(matchServices(query, await getServices(ctx.companyId), 3, 0.5));
  if (priced.length > 0) {
    const list = priced
      .map((s) => `${s.title} — ${s.price} ₽${s.durationMin > 0 ? `, ${s.durationMin} мин` : ""}`)
      .join("\n");
    return respond(ctx, conversation.id, {
      text: `${list}\n\nЗаписывает администратор — напишите, кого и на когда, и он подберёт время.`,
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

/**
 * Сколько времени считаем, что разговор продолжается: сутки. Та же граница,
 * по которой считается новое обращение (§8).
 */
const MET_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Отвечали ли мы этому человеку за последнее время. */
async function spokeWithin(conversationId: string, windowMs: number): Promise<boolean> {
  const said = await prisma.message.findFirst({
    where: {
      conversationId,
      direction: "OUT",
      deletedAt: null,
      isDraft: false,
      createdAt: { gte: new Date(Date.now() - windowMs) },
    },
    select: { id: true },
  });
  return said !== null;
}

/**
 * Здоровались ли мы с этим человеком сегодня.
 *
 * Считаем по суткам клиники, а не сервера: на UTC-хостинге «сегодня»
 * начиналось бы в три ночи, и утренний разговор попадал бы во вчера.
 *
 * Смотрим только начало наших сообщений: слова «добрый день» встречаются и в
 * середине справки о графике работы, а это не приветствие.
 */
async function greetedToday(conversationId: string): Promise<boolean> {
  const rows = await prisma.message.findMany({
    where: {
      conversationId,
      direction: "OUT",
      deletedAt: null,
      isDraft: false,
      createdAt: { gte: startOfClinicDay(new Date()) },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { body: true },
  });
  return rows.some((m) => startsWithGreeting(m.body));
}

/**
 * Добавить ответное приветствие, если человек поздоровался, а ответ начинается
 * сразу с дела.
 *
 * Здороваемся тем же, чем поздоровались с нами (см. lib/agent/greeting), но
 * без вводной клиники: на вопрос уже отвечено, представляться посреди ответа
 * незачем.
 */
function greetIfNeeded(incoming: string, answer: string, configured: string): string {
  if (!greetingUsed(incoming)) return answer;
  // Модель могла поздороваться сама — второй раз не нужно.
  if (alreadyGreeted([{ role: "assistant", content: answer }], configured)) return answer;

  const hello = greetingText({ incoming, configured, repeat: true }).replace(/\s*Слушаю вас\.?$/i, "");
  return `${hello.trim()} ${answer}`;
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
 * Как обращаться к человеку в ответе. Имя карточки — из YCLIENTS, ему верим;
 * имя контакта — только если это имя, а не ник («amikomiko»). Врачу при
 * пересылке вопроса уходит `patientNameFor`: там и ник помогает узнать, о ком речь.
 */
async function addressNameFor(conversationId: string): Promise<string | null> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { contactName: true, patient: { select: { name: true } } },
  });
  return conv?.patient?.name?.trim() || addressableName(conv?.contactName) || null;
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

async function handleCallback(
  ctx: AgentContext,
  conversationId: string,
  data: string,
): Promise<AgentReply | null> {
  if (data === CONSENT_ACCEPT) {
    await grantConsent(ctx.companyId, conversationId);
    // Первая фраза после согласия — по сути и есть приветствие клиники: до
    // этого пациент видел только юридический текст. Берём её из настроек,
    // чтобы знакомство шло словами клиники, а не нашей заглушкой.
    /**
     * После согласия здороваемся — всегда.
     *
     * Запасным вариантом стояло «Спасибо!»: если клиника не заполнила
     * приветствие в настройках, человек получал «Спасибо, Имя» и сразу деловой
     * текст — без единого приветственного слова. Он только что поздоровался с
     * клиникой, ответил на юридический вопрос и вправе услышать «здравствуйте»
     * прежде всего остального.
     */
    const { greeting } = await assistantMode(ctx.companyId);
    const hello = greeting.trim() || greetingText({ incoming: "здравствуйте", repeat: false });

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
    /**
     * Окошко из статуса уже предложено — просим данные под него.
     *
     * Иначе «Да» на согласие переигрывало бы первый вопрос, а цитаты статуса при
     * повторе уже нет: агент заново спросил бы «на какую услугу?» человека,
     * который ответил на статус с врачом, временем и видом приёма.
     */
    const pending = await pendingQuestion(conversationId);
    /**
     * Анкета ли это — по словам самого пациента, без цитаты и с именами врачей.
     *
     * Цитата статуса «Окошко на завтра к Ирине Алилгаджиевне ✅ 15:40» — это
     * два слова с заглавной и число, то есть по форме «ФИО с возрастом». Судя
     * по сообщению вместе с цитатой, ответ «Можно?» на статус считался
     * присланной анкетой, и после «Да» вместо просьбы о данных отвечала модель.
     */
    const pendingOwn = pending ? withoutQuote(pending) : null;
    const pendingIsIntake = pendingOwn ? looksLikeIntake(pendingOwn, await staffNamesOf(ctx.companyId).catch(() => [])) : false;
    /**
     * Анкету прислали ДО согласия — данные уже у нас. Просить их второй раз
     * нельзя: ниже анкета пойдёт обычным путём и сама закрепит окошко.
     */
    const slotAsk = pendingIsIntake ? null : await offeredSlotAsk(conversationId).catch(() => null);
    if (slotAsk) {
      return respond(ctx, conversationId, { text: `${withoutOffer(hello)}\n\n${slotAsk}`, bookingContext: true });
    }

    /**
     * После согласия продолжаем запись, а не начинаем разговор заново.
     *
     * Согласие теперь спрашивается ровно там, где мы просим персональные
     * данные (§7). Значит «Да» — это разрешение их прислать, и следующий шаг
     * один: попросить данные.
     *
     * Живой диалог, из-за которого это правило появилось. Пациентка сказала,
     * что хочет к Ирине, ответила «взрослого», получила цену, ответила «Да» —
     * и в ответ пришёл весь блок справочника про двух остеопатов. Всё уже было
     * выяснено, оставалось записать данные; вместо этого разговор откатился к
     * началу, и человек прочитал то, что ему уже говорили.
     *
     * Исключение — присланная анкета: там данные уже у нас, и отвечать надо
     * на них, а не просить снова.
     */
    if (pending && !pendingIsIntake) {
      const said = await recentTurns(conversationId);
      const mine = said.filter((t) => t.role === "user").map((t) => t.content);
      if (mine.some((t) => wantsToBook(t) || scheduleTopic(t))) {
        const whom = whomInTalk(pending, said);
        return respond(ctx, conversationId, {
          text: intakeAsk(whom, await osteopathyInTalk(ctx.companyId, pending, said)),
        });
      }
    }

    if (pending) {
      const conv = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { id: true, consentGrantedAt: true, patientId: true },
      });
      const answer = conv ? await replyToQuestion(ctx, conv, pending) : null;
      if (answer) {
        /**
         * Здороваемся один раз.
         *
         * Приветствие клиники и ответ модели, начинающийся с «Здравствуйте,
         * Гульбара!», давали два приветствия подряд в одном сообщении: «Это
         * клиника Алункачевой. / Здравствуйте, …! Нет, в воскресенье мы не
         * работаем». Со стороны это два разных собеседника в одном ответе.
         */
        const text = startsWithGreeting(answer.text)
          ? answer.text
          : `${withoutOffer(hello)}\n\n${answer.text}`;
        return { ...answer, text };
      }
    }

    return respond(ctx, conversationId, {
      text: hello,
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
      platformConsent: true,
    });
  }
  if (data === "prices") {
    /**
     * Пациенту — только то, что он может купить.
     *
     * Прежде уходил весь справочник целиком: сорок восемь строк вместе с
     * заготовками («Название — 0 ₽», «IV-ТЕРАПИЯ — 1 ₽») и служебными
     * позициями («БОС/персонал»). Человек, спросивший цену, получал стену
     * текста, в которой свою услугу нужно было ещё найти.
     */
    const text = priceListText(await getServices(ctx.companyId));
    if (text === null) {
      await escalate(ctx.companyId, conversationId, "MISUNDERSTOOD", "Цены не заполнены в справочнике").catch(() => {});
      return respond(ctx, conversationId, {
        text: "Цены уточнит администратор — передал(а) ему вопрос.",
        buttons: mainMenu(),
      });
    }
    return respond(ctx, conversationId, { text, buttons: mainMenu() });
  }

  if (data === "address") {
    // Адрес — из справочника клиники. Нет записи — честно зовём человека,
    // а не пересказываем весь справочник.
    const rows = await prisma.knowledgeEntry.findMany({
      where: usableKnowledgeWhere(ctx.companyId),
      select: { id: true, topic: true, question: true, answer: true },
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
        // Карточка заводится из переписки: канал и есть источник первого
        // обращения. Это вывод, а не слова администратора — потому DERIVED.
        sourceId: source?.id ?? null,
        sourceConfidence: source ? "DERIVED" : "UNKNOWN",
        sourceDerivedAt: source ? new Date() : null,
      },
      select: { id: true },
    });
    await prisma.patientPhone.create({
      data: { companyId: ctx.companyId, patientId: created.id, phone, isPrimary: true },
    });
    patientId = created.id;
  }

  /**
   * Номер сохраняем на диалоге, а не только в карточке.
   *
   * Адрес чата в WhatsApp больше не содержит телефона: WhatsApp перешёл на
   * скрытые идентификаторы. Значит единственное место, где номер переживёт
   * перезагрузку экрана, — сама переписка.
   */
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { patientId, phoneE164: phone },
  });
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
