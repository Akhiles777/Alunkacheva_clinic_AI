import { prisma } from "@/lib/db";
import { getYclientsClient, YclientsApiError, type YclientsClientHandle } from "./client";
import { isYclientsEnabled } from "./config";
import { apiDate } from "./paging";
import type { YclientsRecord } from "./types";

/**
 * Обратная запись визитов в YCLIENTS (§2).
 *
 * Без неё запись, созданная в платформе, живёт только у нас: администратор в
 * YCLIENTS видит слот свободным и ставит туда второго пациента. Двойная запись
 * в один слот — самая дорогая ошибка этой системы, поэтому здесь разобраны
 * случаи, которые обычно всплывают уже на боевых данных.
 *
 * Разбираемые ситуации:
 *
 *  · интеграция выключена — визит остаётся локальным и помечается так честно,
 *    а не «отправленным»;
 *  · слот заняли между проверкой и записью — визит помечается конфликтом и
 *    попадает к человеку, а не тихо считается созданным;
 *  · сеть оборвалась после создания записи в YCLIENTS — перед повторной
 *    попыткой ищем уже созданную запись и присваиваем её, иначе получим дубль
 *    в чужом расписании;
 *  · у специалиста, услуги или пациента нет соответствия в YCLIENTS — это не
 *    сбой сети, повторять бессмысленно, нужен человек.
 */

export type PushOutcome = "synced" | "skipped" | "conflict" | "failed";

export interface PushResult {
  outcome: PushOutcome;
  message?: string;
}

/** Сколько раз пробуем отправить визит, прежде чем перестать. */
const MAX_ATTEMPTS = 5;

/**
 * Отправить визит в YCLIENTS. Идемпотентна: повторный вызов для уже
 * отправленного визита ничего не делает.
 */
export async function pushAppointment(companyId: string, appointmentId: string): Promise<PushResult> {
  const appt = await prisma.appointment.findFirst({
    where: { id: appointmentId, companyId, deletedAt: null },
    select: {
      id: true,
      yclientsRecordId: true,
      startAt: true,
      durationMin: true,
      syncAttempts: true,
      staff: { select: { yclientsStaffId: true, name: true } },
      primaryService: { select: { yclientsServiceId: true, title: true } },
      patient: {
        select: {
          name: true,
          phones: { where: { isPrimary: true }, select: { phone: true }, take: 1 },
        },
      },
    },
  });
  if (!appt) return { outcome: "skipped", message: "Визит не найден" };
  if (appt.yclientsRecordId !== null) return { outcome: "synced" };

  if (!isYclientsEnabled()) {
    await mark(appointmentId, { syncState: "LOCAL_ONLY", syncError: null });
    return { outcome: "skipped", message: "Интеграция выключена" };
  }

  const client = await getYclientsClient(companyId);
  if (!client) {
    await mark(appointmentId, { syncState: "LOCAL_ONLY", syncError: "Не заданы ключи YCLIENTS" });
    return { outcome: "skipped", message: "Не заданы ключи YCLIENTS" };
  }

  // Связи, без которых запись в YCLIENTS создать нечем. Это не сетевой сбой:
  // повторять бесполезно, нужен человек.
  const staffId = appt.staff?.yclientsStaffId ?? null;
  const phone = appt.patient?.phones[0]?.phone ?? null;
  if (staffId === null) {
    return failPermanently(appointmentId, `Специалист «${appt.staff?.name ?? "—"}» не связан с YCLIENTS`);
  }
  if (!phone) {
    return failPermanently(appointmentId, "У пациента нет телефона — YCLIENTS не примет запись");
  }
  if (appt.syncAttempts >= MAX_ATTEMPTS) {
    return failPermanently(appointmentId, `Не удалось отправить за ${MAX_ATTEMPTS} попыток`);
  }

  /**
   * Перед созданием ищем запись, которая могла остаться после оборванной
   * попытки. Без этого повтор после сетевого сбоя даёт второй визит в том же
   * слоте — ровно то, ради чего вся эта обратная запись и делается.
   */
  const orphan = await findExistingRecord(client, appt.startAt, staffId, phone);
  if (orphan !== null) {
    await mark(appointmentId, {
      syncState: "SYNCED",
      yclientsRecordId: orphan,
      syncError: null,
      lastSyncAt: new Date(),
    });
    return { outcome: "synced", message: "Найдена ранее созданная запись" };
  }

  try {
    const created = await client.send<{ id?: number } | { id?: number }[]>(
      "POST",
      client.endpoints.records(client.creds.companyId),
      {
        staff_id: staffId,
        services: appt.primaryService?.yclientsServiceId
          ? [{ id: appt.primaryService.yclientsServiceId }]
          : [],
        client: { phone, name: appt.patient?.name ?? undefined },
        datetime: appt.startAt.toISOString(),
        seance_length: appt.durationMin * 60,
        // Уведомления пациенту шлёт клиника из YCLIENTS по своим правилам;
        // дублировать их из платформы нельзя.
        send_sms: false,
      },
    );

    const recordId = Array.isArray(created) ? created[0]?.id : created?.id;
    if (typeof recordId !== "number") {
      // Ответ без идентификатора: запись могла быть создана. Не считаем
      // отправленной, но и не создаём вторую — следующая попытка найдёт её
      // поиском выше.
      await bumpAttempt(appointmentId, "Ответ YCLIENTS без идентификатора записи");
      return { outcome: "failed", message: "Ответ YCLIENTS без идентификатора записи" };
    }

    await mark(appointmentId, {
      syncState: "SYNCED",
      yclientsRecordId: recordId,
      syncError: null,
      lastSyncAt: new Date(),
    });
    return { outcome: "synced" };
  } catch (e) {
    const err = e as YclientsApiError;
    const status = typeof err.status === "number" ? err.status : 0;
    const message = err.message ?? "Не удалось отправить запись";

    /**
     * 422 и 409 — YCLIENTS отказал по существу: чаще всего слот уже занят.
     * Повторять бессмысленно, а тихо оставлять визит нельзя: администратор
     * должен увидеть конфликт и перенести приём.
     */
    if (status === 409 || status === 422) {
      await mark(appointmentId, {
        syncState: "CONFLICT",
        syncError: message.slice(0, 500),
        syncAttempts: { increment: 1 },
        lastSyncAt: new Date(),
      });
      return { outcome: "conflict", message };
    }

    await bumpAttempt(appointmentId, message);
    return { outcome: "failed", message };
  }
}

/**
 * Поиск уже созданной записи на тот же слот того же специалиста для того же
 * телефона. Нужен, чтобы повтор после обрыва не создал дубль.
 */
async function findExistingRecord(
  client: YclientsClientHandle,
  startAt: Date,
  staffId: number,
  phone: string,
): Promise<number | null> {
  try {
    const day = apiDate(startAt);
    const records = await client.get<YclientsRecord[]>(
      client.endpoints.records(client.creds.companyId),
      { start_date: day, end_date: day, staff_id: staffId },
    );
    const digits = phone.replace(/\D/g, "");
    const match = (records ?? []).find((r) => {
      if (r.deleted) return false;
      if (r.staff_id !== staffId) return false;
      if (new Date(r.datetime).getTime() !== startAt.getTime()) return false;
      const theirs = (r.client?.phone ?? "").replace(/\D/g, "");
      // Сравниваем по последним десяти цифрам: формат номера у них свой.
      return theirs.slice(-10) === digits.slice(-10);
    });
    return match?.id ?? null;
  } catch {
    // Не смогли проверить — считаем, что записи нет: иначе визит навсегда
    // застрянет в ожидании. Дубль в этом случае маловероятен и виден в сверке.
    return null;
  }
}

async function mark(
  id: string,
  data: Parameters<typeof prisma.appointment.update>[0]["data"],
): Promise<void> {
  await prisma.appointment.update({ where: { id }, data }).catch(() => {});
}

async function bumpAttempt(id: string, error: string): Promise<void> {
  await mark(id, {
    syncState: "FAILED",
    syncError: error.slice(0, 500),
    syncAttempts: { increment: 1 },
    lastSyncAt: new Date(),
  });
}

async function failPermanently(id: string, error: string): Promise<PushResult> {
  await mark(id, {
    syncState: "FAILED",
    syncError: error.slice(0, 500),
    syncAttempts: MAX_ATTEMPTS,
    lastSyncAt: new Date(),
  });
  return { outcome: "failed", message: error };
}

/**
 * Догнать всё, что не уехало: вызывается после включения интеграции и в конце
 * каждой синхронизации. Визиты в прошлом не отправляем — в YCLIENTS их уже не
 * примут, а место в очереди они занимать будут.
 */
export async function pushPendingAppointments(companyId: string): Promise<{
  synced: number;
  conflicts: number;
  failed: number;
}> {
  const pending = await prisma.appointment.findMany({
    where: {
      companyId,
      deletedAt: null,
      yclientsRecordId: null,
      status: { in: ["CREATED", "CONFIRMED"] },
      startAt: { gte: new Date() },
      syncState: { in: ["LOCAL_ONLY", "PENDING", "FAILED"] },
      syncAttempts: { lt: MAX_ATTEMPTS },
    },
    orderBy: { startAt: "asc" },
    select: { id: true },
    take: 200,
  });

  let synced = 0;
  let conflicts = 0;
  let failed = 0;
  for (const row of pending) {
    const res = await pushAppointment(companyId, row.id);
    if (res.outcome === "synced") synced += 1;
    else if (res.outcome === "conflict") conflicts += 1;
    else if (res.outcome === "failed") failed += 1;
  }
  return { synced, conflicts, failed };
}

/**
 * Перенос визита в YCLIENTS.
 *
 * Без этого перенос, сделанный администратором у нас, оставался только у нас:
 * в YCLIENTS визит продолжал стоять на старом времени, старый слот считался
 * занятым, а новый — свободным. Две системы расходились ровно в том, ради
 * чего затевалась интеграция.
 *
 * Визит, которого в YCLIENTS нет (создан у нас и ещё не отправлен), просто
 * уедет туда позже уже с новым временем — отправлять нечего.
 */
export async function pushReschedule(companyId: string, appointmentId: string): Promise<PushResult> {
  return pushChange(companyId, appointmentId, async (client, appt) => {
    await client.send("PUT", client.endpoints.record(client.creds.companyId, appt.yclientsRecordId!), {
      staff_id: appt.staff?.yclientsStaffId ?? undefined,
      datetime: appt.startAt.toISOString(),
      seance_length: appt.durationMin * 60,
      // Уведомления пациенту клиника рассылает из YCLIENTS по своим правилам.
      send_sms: false,
    });
  });
}

/**
 * Отмена визита в YCLIENTS.
 *
 * Отменённый у нас визит обязан освободить слот и там: иначе администратор
 * видит занятое время, которого на самом деле нет, и не ставит туда пациента.
 */
export async function pushCancel(companyId: string, appointmentId: string): Promise<PushResult> {
  return pushChange(companyId, appointmentId, async (client, appt) => {
    await client.send("DELETE", client.endpoints.record(client.creds.companyId, appt.yclientsRecordId!));
  });
}

/**
 * Общая часть переноса и отмены: проверки, единая обработка отказов и
 * запись результата на визит. Отдельно от создания — там своя логика поиска
 * уже созданной записи.
 */
async function pushChange(
  companyId: string,
  appointmentId: string,
  action: (
    client: NonNullable<Awaited<ReturnType<typeof getYclientsClient>>>,
    appt: {
      yclientsRecordId: number | null;
      startAt: Date;
      durationMin: number;
      staff: { yclientsStaffId: number | null } | null;
    },
  ) => Promise<void>,
): Promise<PushResult> {
  const appt = await prisma.appointment.findFirst({
    where: { id: appointmentId, companyId },
    select: {
      yclientsRecordId: true,
      startAt: true,
      durationMin: true,
      staff: { select: { yclientsStaffId: true } },
    },
  });
  // Визита нет в YCLIENTS — синхронизировать нечего: он уедет туда позже уже
  // в новом виде.
  if (!appt?.yclientsRecordId) return { outcome: "skipped" };
  if (!isYclientsEnabled()) return { outcome: "skipped", message: "Интеграция выключена" };

  const client = await getYclientsClient(companyId);
  if (!client) return { outcome: "skipped", message: "Не заданы ключи YCLIENTS" };

  try {
    await action(client, appt);
    await mark(appointmentId, { syncState: "SYNCED", syncError: null, lastSyncAt: new Date() });
    return { outcome: "synced" };
  } catch (e) {
    const err = e as YclientsApiError;
    const message = err.message ?? "Не удалось изменить запись в YCLIENTS";

    /**
     * Отказ по существу: новое время занято или запись там уже удалена.
     * Повторять бессмысленно — нужен человек, иначе расхождение так и
     * останется незамеченным.
     */
    if (err.status === 409 || err.status === 422 || err.status === 404) {
      await mark(appointmentId, {
        syncState: "CONFLICT",
        syncError: message.slice(0, 500),
        lastSyncAt: new Date(),
      });
      return { outcome: "conflict", message };
    }

    await bumpAttempt(appointmentId, message);
    return { outcome: "failed", message };
  }
}
