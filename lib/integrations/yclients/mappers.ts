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
  revenueSource: "RECORD" | "FREE" | "PRICE_LIST" | "UNKNOWN";
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

/** visit_attendance YCLIENTS → наш статус визита. deleted перекрывает всё. */
export function mapRecordStatus(visitAttendance: number | undefined, deleted?: boolean): AppointmentStatus {
  if (deleted) return "CANCELLED";
  switch (visitAttendance) {
    case -1:
      return "NO_SHOW";
    case 1:
      return "ARRIVED";
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
 *   1. `cost` больше нуля — это факт, дальше не смотрим.
 *   2. `cost` = 0 и скидка сто процентов — услуга отдана даром, ноль настоящий.
 *   3. `cost` = 0 без скидки — стоимость не проставлена, берём цену по прайсу
 *      из самой записи: она относится ко дню визита (§8).
 *
 * Различает второй и третий случай только скидка. Ни `first_cost`, ни
 * `amount` не помогают: провайдер кладёт их всегда, и незаполненная стоимость
 * выглядит по ним точно так же, как подарок. Проверка этого на живых данных
 * стоила трёх миллионов рублей выручки, обнулённых по ошибке.
 */
export type ServiceRevenueSource = "RECORD" | "FREE" | "PRICE_LIST" | "UNKNOWN";

export interface ServiceRevenue {
  amount: number;
  source: ServiceRevenueSource;
}

export function serviceRevenue(s: YclientsRecordService): ServiceRevenue {
  const cost = s.cost ?? 0;
  if (cost > 0) return { amount: cost, source: "RECORD" };
  if ((s.discount ?? 0) >= 100) return { amount: 0, source: "FREE" };
  const list = s.first_cost ?? 0;
  return list > 0 ? { amount: list, source: "PRICE_LIST" } : { amount: 0, source: "UNKNOWN" };
}

/**
 * Разбор всех услуг записи: сумма и откуда она сложилась.
 *
 * Подпись визита выбирается по составу: всё даром — «бесплатно»; хоть одна
 * цена подставлена — «из прайса»; иначе — «из записи». Так на экране видно,
 * насколько сумме можно верить.
 */
export interface RecordRevenue {
  amount: number;
  source: ServiceRevenueSource;
  /** Услуги, по которым цену взять было неоткуда: ни стоимости, ни прайса. */
  unpriced: number;
}

export function recordRevenue(dto: YclientsRecord): RecordRevenue {
  const services = dto.services ?? [];
  if (services.length === 0) return { amount: 0, source: "UNKNOWN", unpriced: 0 };

  const parts = services.map(serviceRevenue);
  const amount = parts.reduce((sum, p) => sum + p.amount, 0);
  const unpriced = parts.filter((p) => p.source === "UNKNOWN").length;

  if (parts.every((p) => p.source === "FREE")) return { amount: 0, source: "FREE", unpriced };
  if (parts.some((p) => p.source === "PRICE_LIST")) return { amount, source: "PRICE_LIST", unpriced };
  if (amount === 0 && unpriced > 0) return { amount: 0, source: "UNKNOWN", unpriced };
  return { amount, source: "RECORD", unpriced };
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
    status: mapRecordStatus(dto.visit_attendance, dto.deleted),
    revenue: money.amount,
    isPaid: mapPaid(dto),
    createdAtYclients: mapCreatedAt(dto),
  };
}
