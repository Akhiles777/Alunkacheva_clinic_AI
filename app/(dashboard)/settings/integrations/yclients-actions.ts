"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import { writeAudit } from "@/lib/server/audit";
import { isYclientsEnabled } from "@/lib/integrations/yclients/config";
import { syncAll } from "@/lib/integrations/yclients/sync";
import { reconcile, type ReconcileReport } from "@/lib/integrations/yclients/reconcile";
import { pushPendingAppointments } from "@/lib/integrations/yclients/write-back";

/**
 * Управление синхронизацией YCLIENTS из настроек.
 *
 * Начальная выгрузка, состояние по каждой сущности и сверка должны быть видны
 * человеку: до сих пор всё это жило в базе, и посмотреть, прошла выгрузка или
 * молча оборвалась на второй странице, было негде.
 */

export interface CursorView {
  entity: string;
  label: string;
  status: string;
  lastSyncedAt: string | null;
  error: string | null;
}

export interface YclientsState {
  enabled: boolean;
  /** Заданы ли ключи: без них выгрузка не пойдёт. */
  configured: boolean;
  cursors: CursorView[];
  /** Визиты, созданные у нас и не отправленные в YCLIENTS. */
  notPushed: number;
  /** Визиты, которые YCLIENTS не принял: слот занят. */
  conflicts: number;
}

const ENTITY_LABEL: Record<string, string> = {
  SERVICES: "Услуги",
  STAFF: "Специалисты",
  RESOURCES: "Кабинеты",
  CLIENTS: "Пациенты",
  RECORDS: "Визиты",
};

const STATUS_LABEL: Record<string, string> = {
  IDLE: "не запускалась",
  RUNNING: "идёт",
  OK: "успешно",
  FAILED: "ошибка",
};

const when = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});

export async function getYclientsState(): Promise<YclientsState> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");
  const companyId = session.companyId;

  const [cursors, creds, notPushed, conflicts] = await Promise.all([
    prisma.syncCursor.findMany({ where: { companyId } }),
    /**
     * Провайдер в таблице Credential — обычная строка в нижнем регистре, как
     * её пишет раздел «Интеграции». Здесь стояло «YCLIENTS», и подсчёт всегда
     * давал ноль: экран сообщал «не заданы ключи» при заполненных ключах, а
     * кнопки выгрузки и сверки оставались заблокированными навсегда.
     */
    prisma.credential.count({ where: { companyId, provider: "yclients" } }),
    prisma.appointment.count({
      where: { companyId, deletedAt: null, yclientsRecordId: null, startAt: { gte: new Date() } },
    }),
    prisma.appointment.count({ where: { companyId, deletedAt: null, syncState: "CONFLICT" } }),
  ]);

  const byEntity = new Map(cursors.map((c) => [c.entity, c]));
  return {
    enabled: isYclientsEnabled(),
    configured: creds >= 3,
    cursors: Object.keys(ENTITY_LABEL).map((entity) => {
      const row = byEntity.get(entity as never);
      return {
        entity,
        label: ENTITY_LABEL[entity],
        status: STATUS_LABEL[row?.status ?? "IDLE"] ?? "не запускалась",
        lastSyncedAt: row?.lastSyncedAt ? when.format(row.lastSyncedAt) : null,
        error: row?.error ?? null,
      };
    }),
    notPushed,
    conflicts,
  };
}

export interface RunResult {
  ok: boolean;
  message: string;
  counts?: Record<string, number>;
  errors?: string[];
}

/**
 * Запустить выгрузку. Начальная и повторная — одна и та же операция: разница
 * только в курсорах, которые уже стоят.
 */
export async function runYclientsSync(): Promise<RunResult> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");

  if (!isYclientsEnabled()) {
    return { ok: false, message: "Интеграция выключена: задайте YCLIENTS_ENABLED=true на хостинге." };
  }

  const res = await syncAll(session.companyId);
  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "yclients_sync",
    meta: { counts: res.counts, errors: res.errors.length },
  });

  if (res.skipped) {
    return { ok: false, message: "Не заданы ключи YCLIENTS — выгружать нечем." };
  }
  return {
    ok: res.errors.length === 0,
    message:
      res.errors.length === 0
        ? "Выгрузка завершена."
        : `Выгрузка завершена с ошибками: ${res.errors.length}.`,
    counts: res.counts as Record<string, number>,
    errors: res.errors,
  };
}

/** Сверка: сколько сущностей у них и сколько у нас. */
export async function runYclientsReconcile(): Promise<ReconcileReport> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");
  return reconcile(session.companyId);
}

/** Догнать визиты, которые не уехали в YCLIENTS. */
export async function retryPending(): Promise<RunResult> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");
  if (!isYclientsEnabled()) {
    return { ok: false, message: "Интеграция выключена." };
  }
  const res = await pushPendingAppointments(session.companyId);
  return {
    ok: res.conflicts === 0 && res.failed === 0,
    message: `Отправлено ${res.synced}, конфликтов ${res.conflicts}, не удалось ${res.failed}.`,
  };
}
