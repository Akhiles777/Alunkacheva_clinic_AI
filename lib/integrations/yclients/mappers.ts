import { normalizePhone } from "../../phone";
import type { AppointmentStatus, ServiceKind } from "@/generated/prisma/enums";
import type {
  YclientsClient,
  YclientsRecord,
  YclientsRecordService,
  YclientsResource,
  YclientsService,
  YclientsStaff,
} from "./types";

/**
 * Чистые преобразования DTO YCLIENTS → входные данные для проекции Prisma.
 * Без обращений к БД — маппинг детерминирован и покрыт тестами (§11). Слой sync
 * берёт эти объекты и делает идемпотентный upsert по yclients*Id.
 */
export interface ServiceUpsert {
  yclientsServiceId: number;
  title: string;
  price: number;
  durationMin: number;
  kind: ServiceKind;
  isActive: boolean;
}
export interface StaffUpsert {
  yclientsStaffId: number;
  name: string;
  specialty: string | null;
  isActive: boolean;
}
export interface RoomUpsert {
  yclientsResourceId: number;
  name: string;
}
export interface PatientUpsert {
  yclientsId: number;
  name: string | null;
  phoneE164: string | null;
  /** Дата первого визита в YCLIENTS; null — там её нет. */
  firstSeenAt: Date | null;
}
export interface AppointmentUpsert {
  yclientsRecordId: number;
  /** Визит YCLIENTS: несколько записей одного прихода делят его номер. */
  yclientsVisitId: number | null;
  yclientsStaffId: number;
  yclientsResourceId: number | null;
  yclientsServiceIds: number[];
  clientPhoneE164: string | null;
  startAt: Date;
  durationMin: number;
  status: AppointmentStatus;
  revenue: number;
  /** Полностью оплачен по данным YCLIENTS — основа выручки (§8). */
  isPaid: boolean;
  /** Когда запись создана в YCLIENTS; null — провайдер не сообщил. */
  createdAtYclients: Date | null;
  /**
   * Откуда сложилась сумма визита: из записи, из прайса, даром или неизвестно.
   * Считается по каждой услуге отдельно — визит из подаренной и платной
   * позиций не бесплатный и не полностью платный.
   */
  revenueSource: ServiceRevenueSource;
}

/** Секунды сеанса YCLIENTS → минуты. Пустое/битое → 0. */
export function seanceToMinutes(seconds: number | undefined): number {
  if (!seconds || seconds < 0) return 0;
  return Math.round(seconds / 60);
}

/** Направление услуги. Пока грубая эвристика по названию; уточним позже. */
export function guessServiceKind(title: string): ServiceKind {
  const t = title.toLowerCase();
  if (t.includes("остеопат")) return "OSTEOPATHY";
  if (t.includes("бос")) return "BIOFEEDBACK";
  if (t.includes("капельниц") || t.includes("iv") || t.includes("терапи")) return "IV_THERAPY";
  if (t.includes("нейромед") || t.includes("медитац")) return "NEUROMEDITATION";
  if (t.includes("анализ") || t.includes("забор")) return "LAB";
  return "OTHER";
}

export function mapService(dto: YclientsService): ServiceUpsert {
  return {
    yclientsServiceId: dto.id,
    title: dto.title,
    price: dto.price ?? dto.price_min ?? 0,
    durationMin: seanceToMinutes(dto.seance_length),
    kind: guessServiceKind(dto.title),
    isActive: dto.active !== 0,
  };
}

export function mapStaff(dto: YclientsStaff): StaffUpsert {
  return {
    yclientsStaffId: dto.id,
    name: dto.name,
    specialty: dto.specialization?.trim() || null,
    isActive: dto.fired !== 1,
  };
}

export function mapResource(dto: YclientsResource): RoomUpsert {
  return { yclientsResourceId: dto.id, name: dto.title };
}

export function mapClient(dto: YclientsClient): PatientUpsert {
  return {
    yclientsId: dto.id,
    name: dto.name?.trim() || null,
    phoneE164: normalizePhone(dto.phone),
    firstSeenAt: parseYclientsDate(dto.first_visit_date),
  };
}

/**
 * Дата первого визита из YCLIENTS.
 *
 * Без неё выгрузка ставила всем пациентам «первое обращение — сейчас», то
 * есть день импорта. В интерфейсе полторы тысячи человек с многолетней
 * историей разом становились первичными, а метрика «новые пациенты» за месяц
 * импорта показывала всю базу клиники.
 *
 * Формат у них «2023-11-09 12:00:00» — без часового пояса, время местное.
 * Берём дату, время не важно: нас интересует день первого визита.
 */
export function parseYclientsDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * visit_attendance YCLIENTS → наш статус визита. deleted перекрывает всё.
 *
 * Отдельно разбирается «пришёл» на визит, время которого ещё не наступило.
 * На боевых данных такой нашёлся: приём девятнадцатого августа помечен
 * состоявшимся восемнадцатого. Так бывает, когда запись переносят на другую
 * дату — отметка о посещении остаётся с прежнего дня, — или когда её ставят
 * заранее.
 *
 * Считать такой визит состоявшимся нельзя: он даёт выручку, которой ещё нет,
 * завышает число пришедших и портит доходимость. Отметку из YCLIENTS мы при
 * этом не теряем — она лежит в attendanceRaw, — а статус ставим тот, что
 * соответствует действительности: запись подтверждена, но не состоялась.
 *
 * Когда время придёт, ближайшая выгрузка поставит «пришёл» сама.
 */
export function mapRecordStatus(
  visitAttendance: number | undefined,
  deleted?: boolean,
  /** Начало визита и «сейчас» — чтобы отличить состоявшийся приём от будущего. */
  startAt?: Date,
  now: Date = new Date(),
): AppointmentStatus {
  if (deleted) return "CANCELLED";
  switch (visitAttendance) {
    case -1:
      return "NO_SHOW";
    case 1:
      // Приём ещё не начался — состояться он не мог.
      return startAt && startAt.getTime() > now.getTime() ? "CONFIRMED" : "ARRIVED";
    case 2:
      return "CONFIRMED";
    case 0:
    default:
      return "CREATED";
  }
}

/**
 * Оплачен ли визит.
 *
 * §8 определяет выручку как сумму по оплаченным визитам. Провайдер сообщает
 * оплату по-разному: строкой «paid_full» или числом. Считаем оплаченным только
 * полную оплату — частичная это ещё не выручка, и записывать её целиком было бы
 * припиской.
 *
 * Неизвестное значение — не оплачено. Ошибиться в сторону занижения безопаснее:
 * завышенная выручка в отчёте владельца хуже, чем заниженная.
 */
export function mapPaid(dto: YclientsRecord): boolean {
  const raw = dto.payment_status;
  if (typeof raw === "string") return raw.trim().toLowerCase() === "paid_full";
  if (typeof raw === "number") return raw === 2;
  if (typeof dto.paid_full === "number") return dto.paid_full === 1;
  return false;
}

/**
 * Когда запись создана в YCLIENTS. Нет ни одного из известных полей — null:
 * подставлять дату визита нельзя, иначе метрика «записались за месяц» тихо
 * превратится в «приёмов за месяц», и никто этого не заметит.
 */
export function mapCreatedAt(dto: YclientsRecord): Date | null {
  const raw = dto.create_date ?? dto.created_at ?? dto.date_create;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Стоимость ОДНОЙ услуги в записи и откуда она взялась.
 *
 * Считать надо по каждой услуге отдельно. Визит из двух позиций — подаренной и
 * платной — не бесплатный и не полностью платный: в нём ровно столько денег,
 * сколько стоит вторая позиция. Правило «весь визит бесплатный или весь
 * платный» врало бы в обе стороны.
 *
 * Порядок источников:
 *
 *   1. `cost` больше нуля — деньги приняты в этот день, это факт.
 *   2. `cost` = 0 и скидка сто процентов — услуга отдана даром.
 *   3. `cost` = 0 без скидки — деньги по этой услуге приняты не сегодня.
 *
 * Третий случай раньше закрывался ценой из прайса: считалось, что
 * администратор просто не проставил стоимость. На живых данных это оказалось
 * неверно. Так выглядит сеанс курса: пациент заплатил 28 000 ₽ за десять
 * сеансов БОС в день продажи, и в записи каждого сеанса стоит ноль — потому
 * что деньги уже получены. Подставляя цену, платформа считала одни и те же
 * рубли одиннадцать раз: за день выходило 61 280 ₽ там, где клиника называет
 * 43 480 ₽.
 *
 * Поэтому ноль остаётся нулём. Выручку курса даёт запись, в которой стоимость
 * проставлена — день продажи (§8).
 *
 * Ни `first_cost`, ни `amount` тут не помощники: провайдер кладёт их всегда, и
 * сеанс курса выглядит по ним ровно как подарок и как забытая цена. Одна
 * проверка этого вывода на живых данных стоила трёх миллионов рублей выручки,
 * обнулённых по ошибке.
 */
export type ServiceRevenueSource = "RECORD" | "FREE" | "PREPAID" | "UNKNOWN";

export interface ServiceRevenue {
  amount: number;
  source: ServiceRevenueSource;
}

export function serviceRevenue(s: YclientsRecordService): ServiceRevenue {
  const cost = s.cost ?? 0;
  if (cost > 0) return { amount: cost, source: "RECORD" };
  if ((s.discount ?? 0) >= 100) return { amount: 0, source: "FREE" };
  return { amount: 0, source: "PREPAID" };
}

/**
 * Разбор всех услуг записи: сумма и откуда она сложилась.
 *
 * Подпись визита выбирается по составу: всё даром — «бесплатно»; денег нет ни
 * по одной услуге и подарком это не объявлено — «оплачено раньше»; иначе
 * «из записи». Так на экране видно, почему у визита стоит ноль, и жалобу
 * «почему приём бесплатный» можно разобрать, а не угадывать.
 */
export interface RecordRevenue {
  amount: number;
  source: ServiceRevenueSource;
  /** Услуги, деньги по которым в этой записи не лежат: сеансы курса. */
  prepaid: number;
}

export function recordRevenue(dto: YclientsRecord): RecordRevenue {
  const services = dto.services ?? [];
  if (services.length === 0) return { amount: 0, source: "UNKNOWN", prepaid: 0 };

  const parts = services.map(serviceRevenue);
  const amount = parts.reduce((sum, p) => sum + p.amount, 0);
  const prepaid = parts.filter((p) => p.source === "PREPAID").length;

  if (parts.every((p) => p.source === "FREE")) return { amount: 0, source: "FREE", prepaid };
  // Платная услуга в визите есть — значит деньги этого дня в записи лежат,
  // даже если рядом стоит сеанс курса.
  if (amount > 0) return { amount, source: "RECORD", prepaid };
  if (prepaid > 0) return { amount: 0, source: "PREPAID", prepaid };
  return { amount: 0, source: "UNKNOWN", prepaid };
}

/**
 * Сколько визит приносит денег, если его курсовые услуги уже оплачены курсом.
 *
 * Отдельной функцией, потому что это правило о деньгах и его легко испортить.
 * Первая же попытка обнуляла визит целиком — и приём «сеанс БОС + капельница»
 * терял стоимость капельницы: состав визитов разошёлся с их суммой на 3 000 ₽,
 * а разрез по услугам с итогом на те же 3 000 ₽.
 *
 * Вычитаем ровно курсовую часть. Ноль означает, что весь приём был сеансом
 * курса; остаток означает, что рядом стояла платная услуга.
 */
export function revenueAfterCourse(
  total: number,
  courseMoney: number,
): { amount: number; source: ServiceRevenueSource } {
  const rest = Math.max(0, total - courseMoney);
  return { amount: rest, source: rest > 0 ? "RECORD" : "PREPAID" };
}

export function mapRecord(dto: YclientsRecord): AppointmentUpsert {
  const services = dto.services ?? [];
  const money = recordRevenue(dto);
  return {
    yclientsRecordId: dto.id,
    yclientsVisitId: typeof dto.visit_id === "number" ? dto.visit_id : null,
    revenueSource: money.source,
    yclientsStaffId: dto.staff_id,
    yclientsResourceId: dto.resource_instances?.[0]?.resource_id ?? null,
    yclientsServiceIds: services.map((s) => s.id),
    clientPhoneE164: normalizePhone(dto.client?.phone),
    startAt: new Date(dto.datetime),
    durationMin: seanceToMinutes(dto.seance_length),
    status: mapRecordStatus(dto.visit_attendance, dto.deleted, new Date(dto.datetime)),
    revenue: money.amount,
    isPaid: mapPaid(dto),
    createdAtYclients: mapCreatedAt(dto),
  };
}
