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
  /** Идёт ли выгрузка прямо сейчас: экран показывает ход и не даёт запустить вторую. */
  running: boolean;
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

/**
 * Считается ли выгрузка идущей.
 *
 * Отметка RUNNING остаётся висеть, если процесс перезапустили посреди работы.
 * Без срока давности кнопка выгрузки блокировалась бы навсегда, и починить
 * это можно было бы только руками в базе.
 */
const STALE_RUN_MINUTES = 30;

function isRunning(c: { status: string; updatedAt: Date }): boolean {
  if (c.status !== "RUNNING") return false;
  return Date.now() - c.updatedAt.getTime() < STALE_RUN_MINUTES * 60_000;
}

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
    running: cursors.some(isRunning),
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
 * Запустить выгрузку.
 *
 * `full` сбрасывает отметки «докуда дошли» и тянет историю заново.
 *
 * Зачем это нужно отдельной кнопкой. Обычный прогон берёт визиты от последней
 * успешной синхронизации, а историю за два года — только когда отметки нет
 * вовсе. Если первая выгрузка прошла с ошибкой в разборе, но без исключения,
 * отметка всё равно встаёт на «сейчас», и дальше каждый запуск забирает
 * последнюю неделю. Внешне выглядит как «выгрузка прошла, а визитов нет» — и
 * именно это случилось у клиники: из 3759 визитов доехал один, а повторные
 * запуски ничего не меняли.
 */
/**
 * Запустить выгрузку и сразу вернуть управление.
 *
 * Полная выгрузка — это семьдесят с лишним запросов за клиентами и визиты
 * помесячными окнами за два года, то есть минуты работы. Раньше она шла прямо
 * внутри запроса от браузера: обратный прокси разрывал соединение по своему
 * сроку ожидания, и администратор видел «Не удалось выполнить действие», хотя
 * на сервере выгрузка продолжалась. Повторное нажатие запускало вторую поверх
 * первой.
 *
 * Теперь запуск и ожидание разделены: действие только стартует работу, а ход
 * виден по отметкам синхронизации — их обновляет сама выгрузка. Страница
 * опрашивает состояние и показывает, что происходит.
 */
export async function startYclientsSync(full = false): Promise<RunResult> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");

  if (!isYclientsEnabled()) {
    return { ok: false, message: "Интеграция выключена: задайте YCLIENTS_ENABLED=true на хостинге." };
  }

  const cursors = await prisma.syncCursor.findMany({ where: { companyId: session.companyId } });
  if (cursors.some(isRunning)) {
    return { ok: false, message: "Выгрузка уже идёт — дождитесь окончания." };
  }

  if (full) {
    // Сносим только отметки о ходе. Данные остаются: выгрузка идёт по
    // уникальным идентификаторам и дублей не создаёт.
    await prisma.syncCursor.deleteMany({ where: { companyId: session.companyId } });
  }

  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "yclients_sync",
    meta: { started: true, full },
  });

  /**
   * Намеренно не ждём. Процесс живёт под pm2 и продолжает работу после
   * ответа; ошибки видны в отметках синхронизации и в журнале.
   */
  const companyId = session.companyId;
  void syncAll(companyId).catch((e) => {
    console.error("[yclients] выгрузка упала:", e);
  });

  return {
    ok: true,
    message: full
      ? "Полная выгрузка запущена. Историю тянем заново, это займёт несколько минут."
      : "Выгрузка запущена.",
  };
}

export async function runYclientsSync(full = false): Promise<RunResult> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");

  if (!isYclientsEnabled()) {
    return { ok: false, message: "Интеграция выключена: задайте YCLIENTS_ENABLED=true на хостинге." };
  }

  if (full) {
    // Сносим только отметки о ходе синхронизации. Сами данные остаются:
    // выгрузка идёт по уникальным идентификаторам и дублей не создаёт.
    await prisma.syncCursor.deleteMany({ where: { companyId: session.companyId } });
  }

  const res = await syncAll(session.companyId);
  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "yclients_sync",
    meta: { counts: res.counts, errors: res.errors.length, full },
  });

  if (res.skipped) {
    return { ok: false, message: "Не заданы ключи YCLIENTS — выгружать нечем." };
  }
  return {
    ok: res.errors.length === 0,
    message:
      res.errors.length === 0
        ? full
          ? "Полная выгрузка завершена: история загружена заново."
          : "Выгрузка завершена."
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
