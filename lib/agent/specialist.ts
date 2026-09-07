import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { chatIdFromPhone } from "@/lib/integrations/whatsapp/chat-id";
import { sendText as sendWhatsapp } from "@/lib/integrations/whatsapp/green-api";
import { escalationRecipients, notifyStaff } from "@/lib/server/notify";
import { withoutQuote } from "./quoted";
import { declinesRelay, refFromQuote, refMark } from "./specialist-rules";
import { relayDoctorAnswer } from "./llm";
import { ungroundedNumbers } from "./grounding";
import { inventedIndication } from "./indications";
import { forMessenger } from "./messenger-text";

/**
 * Вопрос врачу и руководству клиники.
 *
 * Живой случай, с которого всё началось. Пациентка: «Она говорила отписаться
 * по поводу головных болей, у меня пошли месячные и голова болела как раньше».
 * Агент по §6 отвечать на такое не имеет права и передал администратору; тот
 * переслал сообщение врачу руками, дождался ответа и написал пациентке сам.
 * Три пересадки и полдня на вопрос, ответ на который знает один человек.
 *
 * Теперь агент спрашивает сам — и пересказывает ответ пациенту. Границы при
 * этом не двигаются: записью, временем и подтверждением по-прежнему занимается
 * администратор, а собственной медицинской эрудицией агент не пользуется
 * никогда. Он только доносит слова врача.
 *
 * Чего здесь нет намеренно:
 *   • спама. Пока по диалогу висит неотвеченный вопрос, второй не уходит;
 *   • самодеятельности. Есть готовый ответ в справочнике — врача не трогаем,
 *     это решает вызывающая сторона (агент ищет справку раньше);
 *   • доверчивости. «Не отправляй, я сама» — не ответ пациенту (specialist-rules).
 */

/** Сколько ждём ответа, прежде чем разрешить задать по диалогу новый вопрос. */
export const QUERY_QUIET_HOURS = 12;

/** Сколько сообщений пациента собираем в вопрос: он пишет их подряд. */
const BUNDLE_LIMIT = 6;
/** За какое время до текущего сообщения они считаются одной мыслью. */
const BUNDLE_WINDOW_MS = 30 * 60 * 1000;

export type QueryKind = "MEDICAL" | "MANAGEMENT";

/**
 * Отправка специалисту.
 *
 * На прогоне сценариев (scripts/agent-drill.ts) настоящей отправки нет: там
 * нет ключей провайдера, а будить живого врача проверкой нельзя. Сообщение
 * пишем в журнал — по нему и видно, что именно ей ушло бы.
 */
async function deliver(
  companyId: string,
  to: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  if (process.env.AGENT_DRILL === "1") {
    console.log(`[drill] специалисту ${to}:\n${text}`);
    return { ok: true };
  }
  return sendWhatsapp(companyId, to, text);
}

/** Как называем адресата пациенту: врач и руководство — разные слова. */
function addressee(kind: QueryKind): string {
  return kind === "MEDICAL" ? "врачу" : "руководству клиники";
}

/** Кому пересылать вопрос этого рода. */
export async function specialistFor(companyId: string, kind: QueryKind) {
  return prisma.clinicSpecialist.findFirst({
    where: {
      companyId,
      isActive: true,
      ...(kind === "MEDICAL" ? { isDoctor: true } : { isManager: true }),
    },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Специалист по входящему сообщению.
 *
 * Сверяем и номер, и адрес чата. Номер надёжнее, но WhatsApp перешёл на
 * скрытые идентификаторы (`@lid`), и у части чатов его в событии просто нет —
 * тогда спасает адрес, собранный из телефона специалиста. Не узнать её здесь
 * значит завести на врача пациентский диалог и ответить ей «здравствуйте, чем
 * могу помочь».
 */
export async function specialistForChat(
  companyId: string,
  incoming: { phone?: string | null; chatId?: string | null },
) {
  const rows = await prisma.clinicSpecialist.findMany({
    where: { companyId, isActive: true },
  });
  if (rows.length === 0) return null;

  const e164 = normalizePhone(incoming.phone);
  const chat = incoming.chatId?.trim().toLowerCase() ?? null;
  return (
    rows.find((r) => {
      if (e164 && r.phone === e164) return true;
      const own = chatIdFromPhone(r.phone);
      return Boolean(chat && own && own.toLowerCase() === chat);
    }) ?? null
  );
}

/**
 * Что именно спросил пациент.
 *
 * Собираем последние его сообщения, а не одно: «Здравствуйте, я была на приёме
 * у Ирины» и «она говорила отписаться по поводу головных болей» — это один
 * вопрос, разбитый на две реплики. Врачу нужен весь его текст, иначе она
 * ответит не на то.
 */
async function bundleQuestion(conversationId: string, now: Date): Promise<string> {
  const rows = await prisma.message.findMany({
    where: {
      conversationId,
      direction: "IN",
      deletedAt: null,
      isDraft: false,
      createdAt: { gte: new Date(now.getTime() - BUNDLE_WINDOW_MS) },
    },
    orderBy: { createdAt: "desc" },
    take: BUNDLE_LIMIT,
    select: { body: true },
  });
  return rows
    .reverse()
    .map((m) => withoutQuote(m.body).trim())
    .filter(Boolean)
    .join("\n");
}

/** Следующий короткий номер вопроса в клинике. */
async function nextRef(companyId: string): Promise<number> {
  const last = await prisma.specialistQuery.findFirst({
    where: { companyId },
    orderBy: { ref: "desc" },
    select: { ref: true },
  });
  return (last?.ref ?? 0) + 1;
}

/** Имена активных специалистов: по ним узнаётся отсылка к врачу в ответе. */
export async function specialistNames(companyId: string): Promise<string[]> {
  const rows = await prisma.clinicSpecialist.findMany({
    where: { companyId, isActive: true },
    select: { name: true },
  });
  return rows.map((r) => r.name);
}

export interface AskResult {
  /** Ушёл ли вопрос специалисту. */
  sent: boolean;
  /** Вопрос уже задан раньше и ответа ждём — пациенту это надо сказать иначе. */
  alreadyAsked?: boolean;
  /** Что сказать пациенту, если вопрос ушёл. */
  reply?: string;
  /** Почему не ушёл — для журнала, пациенту это не показывается. */
  reason?: string;
}

/**
 * Спросить специалиста.
 *
 * Возвращает `sent: false`, когда спрашивать не надо или некого: тогда
 * вызывающая сторона отвечает как раньше — передаёт вопрос администратору.
 * Молчаливого «ничего не произошло» здесь быть не может: причина всегда
 * названа словами.
 */
export async function askSpecialist(input: {
  companyId: string;
  conversationId: string;
  patientId?: string | null;
  kind: QueryKind;
  /** Имя пациента для письма специалисту: ей нужно понимать, о ком речь. */
  patientName?: string | null;
  channelLabel?: string;
  now?: Date;
}): Promise<AskResult> {
  const now = input.now ?? new Date();

  const specialist = await specialistFor(input.companyId, input.kind);
  if (!specialist) return { sent: false, reason: "специалист не заведён в настройках" };

  /**
   * Антиспам: один открытый вопрос на диалог.
   *
   * Пациент пишет пять реплик подряд — врач не должна получить пять сообщений.
   * Пока на прошлый вопрос нет ответа, новый не уходит: он всё равно про то
   * же, а собранный текст врач увидит целиком.
   */
  const pending = await prisma.specialistQuery.findFirst({
    where: {
      companyId: input.companyId,
      conversationId: input.conversationId,
      status: "SENT",
      askedAt: { gte: new Date(now.getTime() - QUERY_QUIET_HOURS * 3600 * 1000) },
    },
    select: { id: true },
  });
  if (pending) {
    /**
     * Вопрос уже у врача — так пациенту и говорим.
     *
     * Иначе он слышит «передаю администратору, чтобы уточнили у Ирины
     * Алилгаджиевны» на каждую следующую реплику, хотя вопрос давно задан.
     * Со стороны это выглядит так, будто его гоняют по кругу.
     */
    return {
      sent: false,
      alreadyAsked: true,
      reason: "по этому диалогу вопрос уже отправлен",
      reply:
        input.kind === "MEDICAL"
          ? "Ваш вопрос уже у врача — напишу здесь же, как только она ответит."
          : "Ваш вопрос уже у руководства клиники — ответим здесь же.",
    };
  }

  const question = await bundleQuestion(input.conversationId, now);
  if (question.trim().length < 5) return { sent: false, reason: "нечего пересылать" };

  const ref = await nextRef(input.companyId);
  const who = input.patientName?.trim() || "пациент без имени";
  const where = input.channelLabel ?? "WhatsApp";

  const letter = [
    `Вопрос от пациента — ${who} (${where}) · ${refMark(ref)}`,
    "",
    question,
    "",
    "Ответьте на это сообщение — я перескажу ответ пациенту.",
    "Если отвечать не нужно, напишите «не отправляй».",
  ].join("\n");

  const sent = await deliver(input.companyId, specialist.phone, letter);
  if (!sent.ok) {
    return { sent: false, reason: `не удалось отправить: ${sent.error ?? "причина не записана"}` };
  }

  await prisma.specialistQuery.create({
    data: {
      companyId: input.companyId,
      conversationId: input.conversationId,
      patientId: input.patientId ?? null,
      specialistId: specialist.id,
      kind: input.kind,
      ref,
      question,
      askedAt: now,
    },
  });

  /**
   * Имя специалиста в текст пациенту не подставляем.
   *
   * «Уточню у Ирина Алилгаджиевна» — так по-русски не говорят, а склонять
   * имена кодом значит однажды сделать это неправильно на чьей-нибудь
   * фамилии. Модель, пересказывая ответ, склоняет сама и верно; здесь же
   * достаточно сказать, к кому ушёл вопрос.
   */
  return {
    sent: true,
    reply:
      input.kind === "MEDICAL"
        ? "Уточню у врача и напишу вам здесь же."
        : `Передал(а) ваш вопрос ${addressee(input.kind)} — ответим здесь же.`,
  };
}

/** Что делать с входящим сообщением специалиста. */
export type ReplyOutcome =
  | { kind: "relayed"; ref: number; text: string }
  | { kind: "declined"; ref: number }
  | { kind: "ambiguous"; refs: number[] }
  | { kind: "ignored"; reason: string };

/**
 * Пришло сообщение с номера специалиста.
 *
 * Пациентским агентом оно не обрабатывается никогда: врач — не пациент, её
 * переписка не заводит диалог в инбоксе и не идёт в метрики обращений.
 * Развилка стоит в вебхуке до всего остального.
 */
export async function handleSpecialistReply(input: {
  companyId: string;
  specialist: { id: string; name: string };
  /** Текст как пришёл — вместе со строкой цитаты, если отвечали свайпом. */
  raw: string;
  now?: Date;
}): Promise<ReplyOutcome> {
  const now = input.now ?? new Date();
  const own = withoutQuote(input.raw).trim();
  if (!own) return { kind: "ignored", reason: "пустое сообщение" };

  const specialistPhone = (
    await prisma.clinicSpecialist.findUniqueOrThrow({
      where: { id: input.specialist.id },
      select: { phone: true },
    })
  ).phone;

  const open = await prisma.specialistQuery.findMany({
    where: { companyId: input.companyId, specialistId: input.specialist.id, status: "SENT" },
    orderBy: { askedAt: "desc" },
    take: 10,
  });
  if (open.length === 0) return { kind: "ignored", reason: "открытых вопросов нет" };

  /**
   * К какому вопросу относится ответ.
   *
   * Свайпом — по метке в цитате, это самый надёжный способ. Без цитаты
   * годится только один случай: открытый вопрос ровно один. Гадать нельзя —
   * ответ уйдёт чужому пациенту, и это хуже, чем переспросить.
   */
  const ref = refFromQuote(input.raw);
  const query = ref
    ? (open.find((q) => q.ref === ref) ?? null)
    : open.length === 1
      ? open[0]
      : null;

  if (!query) {
    if (open.length > 1) {
      await deliver(
        input.companyId,
        specialistPhone,
        `Сейчас открыто несколько вопросов: ${open.map((q) => refMark(q.ref)).join(", ")}. ` +
          "Ответьте, пожалуйста, на нужное сообщение — тогда я пойму, к какому он относится.",
      ).catch(() => {});
      return { kind: "ambiguous", refs: open.map((q) => q.ref) };
    }
    return { kind: "ignored", reason: "не удалось понять, к какому вопросу ответ" };
  }

  /**
   * «Не отправляй, я сама» — служебная реплика, а не ответ пациенту.
   *
   * Проверяется до всего остального: сомнение решается в пользу молчания.
   */
  if (declinesRelay(own)) {
    await prisma.specialistQuery.update({
      where: { id: query.id },
      data: { status: "DECLINED", answer: own, answeredAt: now },
    });
    await notifyStaff({
      companyId: input.companyId,
      recipientIds: await escalationRecipients(input.companyId),
      kind: "ESCALATION",
      title: `${input.specialist.name} ответит пациенту сама`,
      body: "Ответ пациенту не отправлен — специалист разбирается сама.",
      url: "/inbox",
      entityId: query.conversationId,
    }).catch(() => {});
    return { kind: "declined", ref: query.ref };
  }

  const relayed = await relayToPatient({
    companyId: input.companyId,
    query,
    doctorName: input.specialist.name,
    doctorPhone: specialistPhone,
    doctorAnswer: own,
    now,
  });
  return { kind: "relayed", ref: query.ref, text: relayed };
}

/**
 * Передать ответ врача пациенту.
 *
 * Пересказ идёт через модель, но смысл её не касается: числа и показания
 * сверяются с текстом врача тем же кодом, что проверяет собственные ответы
 * агента. Расхождение — отправляем слова врача дословно. Красивее не важнее,
 * чем верно.
 */
async function relayToPatient(input: {
  companyId: string;
  query: { id: string; conversationId: string; question: string; ref: number };
  doctorName: string;
  doctorPhone: string;
  doctorAnswer: string;
  now: Date;
}): Promise<string> {
  const conv = await prisma.conversation.findUniqueOrThrow({
    where: { id: input.query.conversationId },
    select: { id: true, channel: true, externalUserId: true, patient: { select: { name: true } } },
  });

  const verbatim = `Уточнила у врача. ${input.doctorAnswer}`;
  const draft = await relayDoctorAnswer({
    question: input.query.question,
    doctorAnswer: input.doctorAnswer,
    doctorName: input.doctorName,
    patientName: conv.patient?.name ?? null,
  });

  let text = verbatim;
  if (draft) {
    const invented = ungroundedNumbers(draft, input.doctorAnswer);
    const madeUp = inventedIndication(draft, input.doctorAnswer);
    if (invented.length > 0) {
      console.error(`[specialist] пересказ отклонён: чисел нет у врача — ${invented.join(", ")}`);
    } else if (madeUp) {
      console.error(`[specialist] пересказ отклонён: показание не от врача — «${madeUp}»`);
    } else {
      text = draft;
    }
  }

  const body = forMessenger(text);
  const sent =
    conv.channel === "WHATSAPP"
      ? await deliver(input.companyId, conv.externalUserId, body)
      : { ok: false, error: `канал ${conv.channel} для передачи ответа не поддержан` };

  await prisma.message.create({
    data: {
      companyId: input.companyId,
      conversationId: conv.id,
      channel: conv.channel,
      direction: "OUT",
      authorType: "BOT",
      body: body.slice(0, 4000),
      status: sent.ok ? "SENT" : "FAILED",
      ...(sent.ok ? {} : { failureReason: sent.error ?? "причина не записана" }),
    },
  });
  await prisma.conversation.update({
    where: { id: conv.id },
    data: { lastMessageAt: input.now },
  });

  await prisma.specialistQuery.update({
    where: { id: input.query.id },
    data: {
      status: "ANSWERED",
      answer: input.doctorAnswer,
      answeredAt: input.now,
      relayed: body,
      relayedAt: sent.ok ? input.now : null,
    },
  });

  /**
   * Подтверждение специалисту: кому именно ушёл её ответ.
   *
   * Без цитаты ответ относится к единственному открытому вопросу — и это
   * единственное место, где можно ошибиться адресатом. Подтверждение делает
   * ошибку видимой сразу: врач прочтёт имя пациента и поправит, если это не
   * тот. Молча угадывать и молчать — худшее сочетание.
   */
  await deliver(
    input.companyId,
    input.doctorPhone,
    `Передала ваш ответ пациенту (${conv.patient?.name ?? "без имени"}, ${refMark(input.query.ref)}).`,
  ).catch(() => {});

  await notifyStaff({
    companyId: input.companyId,
    recipientIds: await escalationRecipients(input.companyId),
    kind: "ESCALATION",
    title: `${input.doctorName} ответила — ответ передан пациенту`,
    body: body.slice(0, 200),
    url: "/inbox",
    entityId: conv.id,
  }).catch(() => {});

  return body;
}
