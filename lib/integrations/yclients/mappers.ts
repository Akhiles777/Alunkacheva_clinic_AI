import { normalizePhone } from "../../phone";
import type { AppointmentStatus, ServiceKind } from "@/generated/prisma/enums";
import type {
  YclientsClient,
  YclientsRecord,
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
}
export interface AppointmentUpsert {
  yclientsRecordId: number;
  yclientsStaffId: number;
  yclientsResourceId: number | null;
  yclientsServiceIds: number[];
  clientPhoneE164: string | null;
  startAt: Date;
  durationMin: number;
  status: AppointmentStatus;
  revenue: number;
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
  };
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

export function mapRecord(dto: YclientsRecord): AppointmentUpsert {
  const services = dto.services ?? [];
  const revenue = services.reduce((sum, s) => sum + (s.cost ?? 0), 0);
  return {
    yclientsRecordId: dto.id,
    yclientsStaffId: dto.staff_id,
    yclientsResourceId: dto.resource_instances?.[0]?.resource_id ?? null,
    yclientsServiceIds: services.map((s) => s.id),
    clientPhoneE164: normalizePhone(dto.client?.phone),
    startAt: new Date(dto.datetime),
    durationMin: seanceToMinutes(dto.seance_length),
    status: mapRecordStatus(dto.visit_attendance, dto.deleted),
    revenue,
  };
}
