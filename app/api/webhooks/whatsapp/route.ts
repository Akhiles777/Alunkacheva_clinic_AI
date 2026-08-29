import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { handlePatientMessage } from "@/lib/agent/clinic-agent";
import { isWhatsappEnabled, WHATSAPP_PROVIDER } from "@/lib/integrations/whatsapp/config";
import { parseWebhook, verifyWebhookSecret } from "@/lib/integrations/whatsapp/webhook";
import { fetchContactPhone, sendText } from "@/lib/integrations/whatsapp/green-api";
import { humanTakeoverUntil } from "@/lib/agent/clinic-agent";
import { messageBody } from "@/lib/agent/attachments";
import { runSerial } from "@/lib/server/background";
import { importWhatsappHistory } from "@/lib/integrations/whatsapp/history";

/**
 * Вебхук WhatsApp (Green API).
 *
 * Отвечаем 200 почти всегда и быстро: на другой код провайдер повторяет
 * доставку, и пациент получает дубли ответов. Отказ отдаём только там, где
 * повтор бессмысленен — выключенная интеграция и неверный секрет.
 *
 * Идемпотентность: сообщение сохраняется с externalId провайдера, а на паре
 * (channel, externalId) стоит уникальный индекс. Повторная доставка того же
 * сообщения не создаёт второй записи и не запускает второй ответ.
 */

export const runtime = "nodejs";
/**
 * Сам запрос теперь короткий: разбор, проверка на повтор и постановка в
 * очередь. Разговор с моделью идёт после ответа провайдеру — см. runSerial.
 */
export const maxDuration = 10;

/**
 * Сколько времени считаем эхом собственного ответа. Администратор, вручную
 * повторяющий текст бота слово в слово через несколько минут, — случай
 * теоретический; бот, перебивший сам себя, — случившийся.
 */
const ECHO_WINDOW_MS = 10 * 60 * 1000;

export async function POST(req: Request) {
  if (!isWhatsappEnabled()) {
    return NextResponse.json({ error: "whatsapp disabled" }, { status: 503 });
  }
  if (!verifyWebhookSecret(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "invalid secret" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    // Разобрать не смогли — повторять бессмысленно, но и ошибку провайдеру
    // отдавать незачем: он будет слать это же тело по кругу.
    return NextResponse.json({ ok: true, ignored: "invalid json" });
  }

  const event = parseWebhook(body);

  if (event.kind !== "message" && event.kind !== "outgoing") {
    /**
     * Статусы доставки, эхо собственных сообщений, смена состояния инстанса и
     * звонки. Их достаточно подтвердить: заводить на них переписку нельзя.
     */
    return NextResponse.json({ ok: true, kind: event.kind });
  }

  /**
   * Чью клинику касается сообщение.
   *
   * Прежде требовалось, чтобы в базе была ровно одна клиника. На боевой базе
   * их оказалось две — настоящая и пустая запись, оставшаяся от ранней
   * настройки, — и каждое сообщение из WhatsApp молча выбрасывалось с
   * пометкой «не удалось определить клинику». Пациент писал, а в инбоксе не
   * появлялось ничего: лишняя строка в таблице стоила потерянных обращений.
   *
   * Теперь порядок такой: клиника, у которой заведены ключи Green API; если
   * такая одна — она и есть адресат. Иначе берём самую раннюю, как и весь
   * остальной интерфейс платформы.
   */
  const companyId = await resolveCompany();
  if (!companyId) {
    return NextResponse.json({ ok: true, ignored: "в базе нет ни одной клиники" });
  }

  /**
   * Повторная доставка. Провайдер шлёт событие заново, если не получил ответ
   * вовремя, — а обработать одно сообщение дважды значит ответить пациенту
   * дважды.
   */
  const seen = await prisma.message.findFirst({
    where: { channel: "WHATSAPP", externalId: event.externalId },
    select: { id: true },
  });
  if (seen) return NextResponse.json({ ok: true, duplicate: true });

  /**
   * Администратор ответил пациенту прямо в WhatsApp на телефоне.
   *
   * Сохраняем его сообщение в переписку и переводим диалог под управление
   * человека: бот замолкает на те же 12 часов, что и после ответа из инбокса
   * (§6.4). Без этого получалось, что человек уже разговаривает с пациентом,
   * а бот отвечает поверх него — и оба выглядят несогласованно.
   */
  if (event.kind === "outgoing") {
    const conv = await prisma.conversation.findFirst({
      where: { companyId, channel: "WHATSAPP", externalUserId: event.chatId },
      select: { id: true },
    });
    // Нет диалога — значит переписку начал сам администратор, и первое
    // сообщение пациента ещё не приходило. Заводить диалог здесь не нужно:
    // он появится, когда пациент ответит.
    if (!conv) return NextResponse.json({ ok: true, ignored: "нет диалога" });

    /**
     * Эхо нашего собственного ответа.
     *
     * Провайдер помечает отправленное через API отдельным типом события, и его
     * мы отбрасываем. Но телефон клиники, подключённый к тому же аккаунту,
     * присылает наш же текст ещё раз — уже как сообщение, набранное на
     * телефоне. Идентификатор у него другой, поэтому проверка на повтор его не
     * ловила.
     *
     * Последствия были не косметические: ответ агента появлялся в переписке
     * дважды, диалог помечался «ведёт человек», и бот замолкал на двенадцать
     * часов — сам себя перебив. Именно так и произошло в диалоге, где на
     * «Расскажите» пациентка не получила ничего.
     *
     * Поэтому сверяем текст: если ровно это мы недавно отправили сами, событие
     * пропускаем.
     */
    const body = messageBody(event.text, event.attachments).slice(0, 4000);
    const echo = await prisma.message.findFirst({
      where: {
        conversationId: conv.id,
        direction: "OUT",
        body,
        createdAt: { gte: new Date(Date.now() - ECHO_WINDOW_MS) },
      },
      select: { id: true, externalId: true },
    });
    if (echo) {
      // Заодно запоминаем идентификатор провайдера: со следующим событием по
      // этому сообщению хватит обычной проверки на повтор.
      if (!echo.externalId) {
        await prisma.message
          .update({ where: { id: echo.id }, data: { externalId: event.externalId } })
          .catch(() => {});
      }
      return NextResponse.json({ ok: true, ignored: "эхо собственного сообщения" });
    }

    await prisma.message.create({
      data: {
        companyId,
        conversationId: conv.id,
        channel: "WHATSAPP",
        direction: "OUT",
        authorType: "STAFF",
        body,
        /**
         * Вложения сохраняем и у исходящих.
         *
         * Их здесь не было вовсе: сотрудник отправлял с телефона две
         * фотографии, в переписке оставалась строка «[фотография]
         * [фотография]» — сами файлы открыть было нельзя, потому что записей о
         * них не появлялось. Пометки в тексте при этом не убирались: инбокс
         * снимает их, только когда вложения есть.
         */
        attachments: event.attachments?.length
          ? (event.attachments as unknown as object[])
          : undefined,
        externalId: event.externalId,
        status: "SENT",
        sentAt: new Date(),
      },
    });
    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        status: "HUMAN_TAKEOVER",
        botPausedUntil: humanTakeoverUntil(),
        lastMessageAt: new Date(),
      },
    });
    return NextResponse.json({ ok: true, kind: "outgoing", takeover: true });
  }

  /**
   * Отвечаем провайдеру сразу, разговор ведём после ответа.
   *
   * Разговор с моделью занимает секунды, а мессенджер ждёт считанные. Пока
   * обработка шла внутри запроса, провайдер не дожидался, обрывал соединение и
   * присылал сообщение заново — а у нас оно уже было сохранено, и повторная
   * доставка отбрасывалась как дубль. Сообщение пациента лежало в переписке без
   * ответа, и человеку приходилось писать второй и третий раз. Ровно это и
   * заметил заказчик.
   *
   * Задачи одного чата идут по очереди: два сообщения подряд иначе
   * обрабатывались одновременно и оба здоровались с одним и тем же человеком.
   */
  runSerial(`whatsapp:${event.chatId}`, () => handleIncoming(companyId, event));
  return NextResponse.json({ ok: true, queued: true });
}

/** Разговор: подгрузка истории, ответ агента, отправка. */
async function handleIncoming(
  companyId: string,
  event: Extract<ReturnType<typeof parseWebhook>, { kind: "message" }>,
): Promise<void> {
  /**
   * Переписка, которая была до подключения платформы.
   *
   * У нас её нет, а у пациента она на экране: он продолжает разговор, начатый
   * месяц назад на телефоне администратора. Без истории ассистент отвечает как
   * незнакомому — здоровается и заново просит согласие. Забираем её у
   * провайдера один раз, при первом сообщении в диалоге, до ответа агента:
   * иначе первая же реплика уйдёт без контекста, а именно она и важна.
   *
   * Сбой здесь не мешает работе: не получилось — отвечаем без истории, как
   * раньше. Терять обращение из-за неудачной подгрузки нельзя.
   */
  try {
    await importWhatsappHistory({
      companyId,
      chatId: event.chatId,
      contactName: event.senderName,
      skipExternalId: event.externalId,
    });
  } catch (e) {
    console.error("[whatsapp] история чата не загрузилась:", e);
  }

  const reply = await handlePatientMessage(
    {
      companyId,
      channel: "WHATSAPP",
      externalUserId: event.chatId,
      displayName: event.senderName,
    },
    {
      text: event.text,
      externalId: event.externalId,
      attachments: event.attachments,
      knownPhone: await resolvePhone(companyId, event),
    },
  );
  if (!reply?.text) return;

  const sent = await sendText(companyId, event.chatId, reply.text);
  if (!sent.ok) {
    /**
     * Ответ не ушёл. Сообщение пациента уже сохранено, диалог виден
     * администратору — это лучше, чем потерять обращение целиком, но человек
     * сидит без ответа и не знает об этом.
     *
     * Бросать здесь нельзя: сообщение обработано, повтор создал бы второй
     * ответ. Поэтому просто оставляем как есть — следующий круг расписания
     * увидит диалог без ответа и доберёт его (lib/agent/unanswered).
     */
    console.error("[whatsapp] ответ не доставлен, доберём следующим кругом:", sent.error);
    await markOutgoing(companyId, event.chatId, reply.text, false);
    return;
  }
  await markOutgoing(companyId, event.chatId, reply.text, true);
  if (!sent.externalId) return;

  /**
   * Запоминаем идентификатор провайдера у своего же ответа.
   *
   * Телефон клиники присылает наш текст обратно как «набранный вручную», и без
   * идентификатора узнать в нём собственный ответ можно было только по
   * совпадению текста. Совпадение — признак хороший, но не точный: достаточно
   * провайдеру подставить невидимый символ, и ответ агента снова задвоится в
   * переписке, а диалог уйдёт в перехват человеком.
   *
   * Обновляем ровно одну строку, найденную по диалогу: один и тот же текст
   * (запрос согласия, например) уходит многим пациентам, а идентификатор
   * провайдера уникален — записать его сразу нескольким сообщениям не даст
   * уникальный индекс.
   */
  const own = await prisma.message.findFirst({
    where: {
      companyId,
      channel: "WHATSAPP",
      direction: "OUT",
      authorType: "BOT",
      body: reply.text,
      externalId: null,
      conversation: { channel: "WHATSAPP", externalUserId: event.chatId },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (own) {
    await prisma.message
      .update({ where: { id: own.id }, data: { externalId: sent.externalId } })
      .catch(() => {});
  }
}

/**
 * Отметить на сообщении, приняла ли его сторона провайдера.
 *
 * Ответ агента сохраняется как «в очереди»: пока отметку никто не ставил,
 * неудачная отправка выглядела успешной — в инбоксе ответ есть, у пациента
 * нет. По отметке «не доставлено» расписание доберёт доставку следующим кругом.
 */
async function markOutgoing(
  companyId: string,
  chatId: string,
  body: string,
  ok: boolean,
): Promise<void> {
  const row = await prisma.message.findFirst({
    where: {
      companyId,
      channel: "WHATSAPP",
      direction: "OUT",
      body,
      status: "QUEUED",
      conversation: { externalUserId: chatId },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!row) return;
  await prisma.message
    .update({
      where: { id: row.id },
      data: ok ? { status: "SENT", sentAt: new Date() } : { status: "FAILED" },
    })
    .catch(() => {});
}

/**
 * Телефон собеседника.
 *
 * Раньше он брался прямо из адреса чата: в WhatsApp адрес и был номером.
 * WhatsApp перешёл на скрытые идентификаторы («…@lid»), номера в адресе нет, и
 * без него не находится карточка пациента — на боевой базе без карточек
 * оказалась почти вся переписка.
 *
 * Порядок: адрес чата (для старых чатов он ещё работает), сохранённый номер
 * диалога, справка провайдера. Последнее — сетевой запрос, поэтому делаем его
 * один раз на диалог и запоминаем результат.
 */
async function resolvePhone(
  companyId: string,
  event: Extract<ReturnType<typeof parseWebhook>, { kind: "message" }>,
): Promise<string | null> {
  if (event.phoneE164) return event.phoneE164;

  const conv = await prisma.conversation.findFirst({
    where: { companyId, channel: "WHATSAPP", externalUserId: event.chatId },
    select: { id: true, phoneE164: true },
  });
  if (conv?.phoneE164) return conv.phoneE164;

  const phone = await fetchContactPhone(companyId, event.chatId).catch(() => null);
  if (!phone) {
    const at = event.chatId.indexOf("@");
    console.warn(`[whatsapp] номер не определён, адрес вида ${at === -1 ? "без @" : event.chatId.slice(at)}`);
    return null;
  }

  if (conv) {
    await prisma.conversation
      .update({ where: { id: conv.id }, data: { phoneE164: phone } })
      .catch(() => {});
  }
  return phone;
}

/** Клиника, которой адресовано сообщение WhatsApp. */
async function resolveCompany(): Promise<string | null> {
  const configured = await prisma.credential.findMany({
    where: { provider: WHATSAPP_PROVIDER, keyName: "id_instance" },
    select: { companyId: true },
    take: 2,
  });
  if (configured.length === 1) return configured[0].companyId;

  const oldest = await prisma.company.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return oldest?.id ?? null;
}

/*
 * Подсказок под сообщениями в WhatsApp нет намеренно.
 *
 * В Telegram это кнопки: они не занимают место в переписке и нажимаются одним
 * касанием. В WhatsApp кнопок нет, и раньше их подписи дописывались строками
 * под каждый ответ — «Услуги и цены, Адрес, Часы работы, Позвать
 * администратора». В живой переписке это выглядит как навязчивое меню под
 * каждой репликой, а не как разговор.
 *
 * Понимать эти слова агент по-прежнему умеет: пациент может написать «адрес»
 * или «позвать администратора», и они сработают (см. lib/agent/text-actions).
 * Перечислять их в каждом сообщении для этого не нужно.
 */
