/**
 * Что ассистент довёл до записи.
 *
 * Определение продажи — заказчика, и оно строже, чем «пациент из переписки
 * записался»: **ассистент сам довёл до готовой заявки НОВОГО человека**. То есть он
 * ответил на вопросы, собрал данные для записи — ФИО, возраст, причину — и
 * администратору осталось поставить время или задать пару уточняющих
 * вопросов.
 *
 * Пациент при этом должен быть новым: до этой заявки у него нет ни визитов,
 * ни записей. Постоянный, записавшийся снова, пришёл бы и без ассистента —
 * его запись это поток клиники, а не работа агента.
 *
 * Почему это не то же самое, что «запись пришла из диалога». В переписке
 * администратор часто ведёт разговор сам с первой реплики: агент промолчал
 * (пауза, выключен, не понял), человека оформил человек. Записывать такое в
 * заслугу ассистента — приписывать себе чужую работу, и число сразу
 * перестаёт что-либо значить. Ровно этим правилом уже живёт очередь «Кому
 * позвонить»: результат считается по отметкам обращений, а не по всему потоку.
 *
 * Считается по фактам переписки, а не по флагу: флаг пришлось бы проставлять
 * в момент разговора и он разъехался бы с действительностью при первом же
 * сбое. Здесь — чистая функция над тем, что уже лежит в базе, поэтому её
 * можно пересчитать за любой прошлый период (заказчик просил разобрать и
 * прошлые разговоры).
 */

import { asksForPersonalData } from "@/lib/agent/intake";

/** Реплика переписки в том виде, в каком её видит расчёт. */
export interface SaleMessage {
  at: Date;
  direction: "IN" | "OUT";
  authorType: "PATIENT" | "BOT" | "STAFF";
  body: string;
}

export interface SaleAppointment {
  id: string;
  createdAt: Date;
  status: string;
  /** Признанная выручка визита: план и факт различаются (§8). */
  revenue: number;
  serviceTitles: string[];
}

export interface SaleInput {
  conversationId: string;
  patientId: string | null;
  messages: SaleMessage[];
  /** Записи этого пациента, созданные после разговора. */
  appointments: SaleAppointment[];
  /**
   * Самое раннее, что у клиники есть на этого пациента: создание первой
   * записи или начало первого приёма — что было раньше.
   *
   * Нужно, чтобы отличить НОВОГО человека от постоянного (решение заказчика,
   * сентябрь 2026). Дату визита берём наравне с датой создания: история,
   * перенесённая из YCLIENTS, создана в базе днём выгрузки, а состоялась
   * годы назад — по одному `createdAt` постоянный пациент выглядел бы новым.
   *
   * `null` — записей нет вовсе: тогда новизну определяет сама заявка.
   */
  earliestActivityAt: Date | null;
}

export interface AgentSale {
  conversationId: string;
  appointmentId: string;
  services: string[];
  /** Деньги состоявшегося визита. Ноль, если визит ещё не прошёл. */
  revenue: number;
  /** Состоялся ли визит: план и факт нельзя складывать (§8). */
  arrived: boolean;
  at: Date;
}

/**
 * Сколько времени между сбором данных и записью считаем связью.
 *
 * Администратор ставит время не мгновенно: он видит заявку и возвращается к
 * ней в перерыве. Двое суток — верхняя граница «по горячим следам»; дальше
 * это уже другой разговор, и приписывать запись ассистенту нельзя.
 */
export const SALE_WINDOW_HOURS = 48;

/**
 * Ассистент попросил данные — по его собственным словам.
 *
 * Правило здесь ОДНО на всю платформу: то же, которым согласие гатит просьбу
 * о персональных данных (`asksForPersonalData`, §7). Пока их было два,
 * метрика видела только «пришлите … ФИО» и не видела всего остального, чем
 * модель просит на самом деле: «для записи мне нужны ФИО и возраст», «назовите
 * ФИО и возраст», «напишите, как зовут ребёнка и сколько ему лет». Заявка была
 * собрана ассистентом, а в число не попадала — отсюда и дыра в статистике
 * владельца.
 *
 * Узкий образец остаётся рядом: он ловит «пришлите … причину обращения», где
 * персональных данных по названию нет, а по сути это та же анкета.
 */
const AGENT_ASKED_DATA =
  /(?:пришлите|напишите|укажите|отправьте)[^.!?\n]{0,80}(?:фио|имя|возраст|причин)/iu;

function agentAskedData(text: string): boolean {
  return asksForPersonalData(text) || AGENT_ASKED_DATA.test(text);
}

/** Ассистент подтвердил, что данные получены и переданы. */
const AGENT_ACCEPTED = /(?:спасибо,?\s+записал|данные\s+переда|передал\(а\)\s+администратору)/iu;

/**
 * Довёл ли ассистент разговор до готовой заявки.
 *
 * Три условия, и все обязательны:
 *   1. данные просил САМ ассистент (сообщение бота);
 *   2. пациент их прислал — следующей репликой или через одну;
 *   3. до этого момента сотрудник в разговор не вмешивался.
 *
 * Третье условие и отделяет работу ассистента от работы человека. Если
 * администратор уже писал в диалог до сбора данных, разговор вёл он, а
 * ассистент в лучшем случае помогал.
 */
export function agentCollectedData(
  messages: SaleMessage[],
  looksLikeIntake: (text: string) => boolean,
): { collectedAt: Date } | null {
  const ordered = [...messages].sort((a, b) => a.at.getTime() - b.at.getTime());

  for (let i = 0; i < ordered.length; i += 1) {
    const m = ordered[i];
    if (m.authorType !== "BOT" || !agentAskedData(m.body)) continue;

    // Сотрудник уже вёл разговор — заслуга не ассистента.
    if (ordered.slice(0, i).some((x) => x.authorType === "STAFF")) return null;

    /**
     * Ответ ищем в ближайших репликах, а не строго в следующей.
     *
     * Между вопросом и анкетой человек успевает спросить своё — «а сколько
     * длится приём?», — агент отвечает, и данные приходят третьим-четвёртым
     * сообщением. Окно в три реплики такие разговоры теряло.
     */
    for (const next of ordered.slice(i + 1, i + 7)) {
      if (next.authorType === "STAFF") break;
      if (next.direction === "IN" && looksLikeIntake(next.body)) {
        return { collectedAt: next.at };
      }
    }
  }

  /**
   * Пациент прислал данные сам, без вопроса, а ассистент их принял.
   *
   * Так тоже бывает: человек пишет «Магомедова Гульбара, 34 года, боли в
   * пояснице» первой же репликой. Работа ассистента здесь в том, что он их
   * распознал, подтвердил и довёл до администратора.
   */
  for (let i = 0; i < ordered.length; i += 1) {
    const m = ordered[i];
    if (m.direction !== "IN" || !looksLikeIntake(m.body)) continue;
    if (ordered.slice(0, i).some((x) => x.authorType === "STAFF")) return null;
    const accepted = ordered
      .slice(i + 1, i + 3)
      .find((x) => x.authorType === "BOT" && AGENT_ACCEPTED.test(x.body));
    if (accepted) return { collectedAt: m.at };
  }

  return null;
}

/**
 * Продажи ассистента по одному диалогу.
 *
 * Возвращает записи, созданные ПОСЛЕ того, как ассистент собрал данные, и не
 * позже окна. Отменённые визиты не считаем: продажи в них нет.
 */
export function salesOf(
  input: SaleInput,
  looksLikeIntake: (text: string) => boolean,
  windowHours: number = SALE_WINDOW_HOURS,
): AgentSale[] {
  const collected = agentCollectedData(input.messages, looksLikeIntake);
  if (!collected) return [];

  const until = new Date(collected.collectedAt.getTime() + windowHours * 3600 * 1000);
  return input.appointments
    .filter((a) => a.status !== "CANCELLED")
    .filter((a) => a.createdAt >= collected.collectedAt && a.createdAt <= until)
    /**
     * Только НОВЫЙ пациент (решение заказчика, сентябрь 2026).
     *
     * Постоянный человек, который написал в тот же чат и записался снова,
     * пришёл бы и без ассистента: клиника его уже знает. Считать такую запись
     * продажей — приписывать себе чужой поток, ровно то, от чего метрика и
     * защищается.
     *
     * «Новый» здесь строгое: до этой заявки у него не было ни визитов, ни
     * записей — даже отменённых и неявок. Отменённая запись означает, что
     * человек уже обращался, и привёл его кто-то другой.
     */
    .filter((a) => input.earliestActivityAt === null || input.earliestActivityAt >= a.createdAt)
    .map((a) => ({
      conversationId: input.conversationId,
      appointmentId: a.id,
      services: a.serviceTitles,
      revenue: a.status === "ARRIVED" ? a.revenue : 0,
      arrived: a.status === "ARRIVED",
      at: a.createdAt,
    }));
}

export interface AgentSalesTotals {
  /** Сколько записей ассистент довёл до администратора. */
  bookings: number;
  /** Из них состоялось — только у них есть деньги (§8). */
  arrived: number;
  /** Деньги состоявшихся визитов. */
  revenue: number;
  /** По услугам: сколько записей и сколько денег принесла каждая. */
  byService: { title: string; bookings: number; arrived: number; revenue: number }[];
}

/** Сводка по списку продаж: одна функция и для экрана, и для аналитика (§8). */
export function totalsOf(sales: AgentSale[]): AgentSalesTotals {
  const byService = new Map<string, { bookings: number; arrived: number; revenue: number }>();
  for (const sale of sales) {
    /**
     * Деньги визита относим к его услугам поровну.
     *
     * У записи бывает несколько услуг, а сумма одна. Делить её по прайсу
     * нельзя: в записи стоит фактическая цена, и она с прайсом не обязана
     * совпадать (§8). Поровну — честнее, чем приписать всё первой строке.
     */
    const titles = sale.services.length > 0 ? sale.services : ["услуга не указана"];
    const share = sale.revenue / titles.length;
    for (const title of titles) {
      const row = byService.get(title) ?? { bookings: 0, arrived: 0, revenue: 0 };
      row.bookings += 1;
      if (sale.arrived) {
        row.arrived += 1;
        row.revenue += share;
      }
      byService.set(title, row);
    }
  }

  return {
    bookings: sales.length,
    arrived: sales.filter((s) => s.arrived).length,
    revenue: sales.reduce((sum, s) => sum + s.revenue, 0),
    byService: [...byService]
      .map(([title, v]) => ({ title, ...v, revenue: Math.round(v.revenue) }))
      .sort((a, b) => b.revenue - a.revenue || b.bookings - a.bookings),
  };
}
