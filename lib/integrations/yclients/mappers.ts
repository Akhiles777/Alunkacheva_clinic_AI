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
   * Услуга отдана бесплатно: скидка сто процентов.
   *
   * Ноль в стоимости означает две разные вещи — «отдали даром» и «цену не
   * проставили», — и различает их только скидка. Первое трогать нельзя,
   * второе закрывается прайсом (§8).
   */
  isFree: boolean;
  /** Цена услуг по прайсу из самой записи: на момент визита, а не сегодняшняя. */
  listPrice: number;
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
 * Бесплатна ли услуга по решению клиники.
 *
 * Первая версия считала «цена известна» по любому следу цены — и ошиблась
 * грубо. На боевых данных выяснилось, что YCLIENTS кладёт в запись
 * `first_cost` (цену услуги по прайсу) и `amount` (КОЛИЧЕСТВО, а не деньги)
 * всегда, независимо от того, проставил администратор стоимость или нет:
 *
 *   cost=0 first_cost=2800 discount=0   — стоимость не проставлена
 *   cost=0 first_cost=3000 discount=100 — скидка 100%, услуга отдана даром
 *
 * По прежнему правилу обе строки становились «бесплатными», и тысяча визитов
 * разом потеряла выручку — три миллиона рублей. Ошибка в ту же сторону, что и
 * исходная жалоба, только больше.
 *
 * Настоящий признак один: скидка сто процентов. Всё остальное с нулевой
 * стоимостью — незаполненная цена, и её место занимает прайс (§8: пришёл на
 * услугу за 8000 ₽ — значит 8000 ₽).
 */
export function serviceIsFree(s: YclientsRecordService): boolean {
  return (s.cost ?? 0) === 0 && (s.discount ?? 0) >= 100;
}

/**
 * Отдан ли визит целиком бесплатно.
 *
 * Достаточно одной платной услуги, чтобы визит перестал быть бесплатным:
 * стоимость визита — сумма его услуг, и обнулять её из-за одной подаренной
 * позиции нельзя.
 */
export function recordIsFree(dto: YclientsRecord): boolean {
  const services = dto.services ?? [];
  if (services.length === 0) return false;
  return services.every(serviceIsFree);
}

/**
 * Цена услуг по прайсу, как её знает сама запись.
 *
 * Лучше справочника клиники: это цена на момент визита, а прайс с тех пор мог
 * измениться. Используется только там, где стоимость не проставлена.
 */
export function recordListPrice(dto: YclientsRecord): number {
  return (dto.services ?? []).reduce((sum, s) => sum + (s.first_cost ?? 0), 0);
}

export function mapRecord(dto: YclientsRecord): AppointmentUpsert {
  const services = dto.services ?? [];
  const revenue = services.reduce((sum, s) => sum + (s.cost ?? 0), 0);
  return {
    yclientsRecordId: dto.id,
    yclientsVisitId: typeof dto.visit_id === "number" ? dto.visit_id : null,
    isFree: recordIsFree(dto),
    listPrice: recordListPrice(dto),
    yclientsStaffId: dto.staff_id,
    yclientsResourceId: dto.resource_instances?.[0]?.resource_id ?? null,
    yclientsServiceIds: services.map((s) => s.id),
    clientPhoneE164: normalizePhone(dto.client?.phone),
    startAt: new Date(dto.datetime),
    durationMin: seanceToMinutes(dto.seance_length),
    status: mapRecordStatus(dto.visit_attendance, dto.deleted),
    revenue,
    isPaid: mapPaid(dto),
    createdAtYclients: mapCreatedAt(dto),
  };
}
