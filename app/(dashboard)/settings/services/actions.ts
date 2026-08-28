"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import { writeAudit } from "@/lib/server/audit";
import { idsToDelete } from "@/lib/server/list-save";
import type { ServiceKind } from "@/generated/prisma/enums";

/**
 * Услуги — доменные таблицы Service + ServiceRoom. Кабинеты услуги — знаменатель
 * загрузки по услугам (§8). Сохранение целиком (reconcile) в транзакции.
 * Локальные услуги имеют yclientsServiceId = null (сопоставление с YCLIENTS —
 * позже). Услугу с визитами или курсами удалить нельзя — только деактивировать.
 */
export interface ServiceRow {
  id: string; // существующие — cuid; новые — "new-*"
  title: string;
  kind: ServiceKind;
  price: number;
  /**
   * Цена задана у нас и выгрузкой не перезаписывается.
   *
   * Экран позволял менять цену, а ближайшая выгрузка возвращала значение из
   * YCLIENTS — правка не держалась и четверти часа, и это читалось как «не
   * сохраняется».
   */
  priceLocked: boolean;
  /** Что по этой услуге говорит YCLIENTS: видно, от чего отличается наша цена. */
  yclientsPrice: number | null;
  durationMin: number;
  isActive: boolean;
  isCourse: boolean;
  defaultSessions: number | null;
  stalledAfterDays: number | null;
  roomIds: string[];
}

export interface ServicesPayload {
  services: ServiceRow[];
  roomOptions: { id: string; label: string }[];
}

/**
 * Итог сохранения — данными, а не исключением.
 *
 * Проверки здесь адресованы человеку: «выберите кабинет», «укажите размер
 * курса». Но `throw` из серверного действия Next в проде заменяет на «An error
 * occurred in the Server Components render» — сообщение до экрана не доезжает
 * вовсе. Человек видит сбой платформы там, где ему хотели сказать, что
 * поправить.
 */
export type SaveServicesResult =
  | { ok: true; payload: ServicesPayload; notice?: string }
  | { ok: false; error: string };

export async function getServices(): Promise<ServicesPayload> {
  const session = await getSession();
  const [services, rooms] = await Promise.all([
    prisma.service.findMany({
      where: { companyId: session.companyId },
      orderBy: { createdAt: "asc" },
      include: { rooms: { select: { roomId: true } } },
    }),
    prisma.room.findMany({
      where: { companyId: session.companyId },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true },
    }),
  ]);
  return {
    services: services.map((s) => ({
      id: s.id,
      title: s.title,
      kind: s.kind,
      price: Number(s.price),
      priceLocked: s.priceLocked,
      yclientsPrice: s.yclientsPrice === null ? null : Number(s.yclientsPrice),
      durationMin: s.durationMin,
      isActive: s.isActive,
      isCourse: s.isCourse,
      defaultSessions: s.defaultSessions,
      stalledAfterDays: s.stalledAfterDays,
      roomIds: s.rooms.map((r) => r.roomId),
    })),
    roomOptions: rooms.map((r) => ({ id: r.id, label: r.name.replace(/ —.*/, "") })),
  };
}

export async function saveServices(
  rows: ServiceRow[],
  /** Идентификаторы, которые экран получил при загрузке (см. idsToDelete). */
  knownIds?: string[],
): Promise<SaveServicesResult> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");
  try {
    return await save(session.companyId, session.userId, rows, knownIds);
  } catch (e) {
    /**
     * Настоящая причина — на экран, а не в пустоту.
     *
     * Любое исключение из серверного действия Next в проде подменяет на «An
     * error occurred in the Server Components render»: сообщение до человека
     * не доезжает, и починить нельзя ничего — даже когда причина простая,
     * вроде запрещённого значения в поле. Персональных данных в тексте
     * ошибки нет, это сообщение базы или валидатора (§7).
     */
    const message = e instanceof Error ? e.message : String(e);
    console.error("[настройки/услуги] сохранение не удалось:", message);
    return { ok: false, error: `Не удалось сохранить: ${message}` };
  }
}

/**
 * Что стоит поправить, но что сохранению не мешает.
 *
 * Молчать нельзя: услуга без кабинета выпадает из загрузки по кабинетам, без
 * длительности — из подсказок при записи. Но и запрещать сохранение из-за
 * этого нельзя — экран станет неработоспособным целиком.
 */
function noticeFor(roomless: number, noDuration: number): string | undefined {
  const parts: string[] = [];
  if (roomless > 0) parts.push(`у ${roomless} не выбран кабинет`);
  if (noDuration > 0) parts.push(`у ${noDuration} не указана длительность`);
  return parts.length > 0 ? `Сохранено. Но ${parts.join(", ")}.` : undefined;
}

async function save(
  companyId: string,
  userId: string | null,
  rows: ServiceRow[],
  knownIds?: string[],
): Promise<SaveServicesResult> {
  // Валидация — платформа не даёт сохранить бессмыслицу.
  for (const s of rows) {
    if (s.title.trim().length === 0) return { ok: false, error: "У услуги должно быть название" };
    if (s.isCourse && (!s.defaultSessions || s.defaultSessions < 1)) {
      return { ok: false, error: `«${s.title}»: у курсовой услуги укажите размер курса` };
    }
    /**
     * Пустое поле цены приходит как NaN.
     *
     * Стереть цену, чтобы набрать новую, — обычное движение, и именно на нём
     * сохранение обрывалось: база отказывалась писать NaN в денежное поле, а
     * человек видел безымянную ошибку сервера. Ловим здесь и говорим словами.
     */
    if (!Number.isFinite(s.price) || s.price < 0) {
      return { ok: false, error: `«${s.title}»: цена должна быть числом` };
    }
  }

  /**
   * Длительность не запрещает сохранение.
   *
   * Здесь стояла жёсткая проверка «целое число больше нуля», и одна услуга из
   * YCLIENTS без длительности — «Остео массаж» — запрещала сохранить весь
   * экран. Это ровно та же ошибка, что была с кабинетом: правило под услуги,
   * заведённые руками, применялось к шестидесяти восьми импортированным.
   *
   * Мусор приводим к нулю, о нуле предупреждаем. Услуга без длительности
   * данные не портит: время визита берётся из записи YCLIENTS, а не из
   * справочника.
   */
  const clean = rows.map((s) => ({
    ...s,
    durationMin: Number.isFinite(s.durationMin) && s.durationMin > 0 ? Math.round(s.durationMin) : 0,
  }));
  const noDuration = clean.filter((s) => s.durationMin === 0);

  /**
   * Кабинет услуги больше не обязателен.
   *
   * Требование стояло жёстким: без кабинета сохранение не проходило. Оно
   * писалось под услуги, заведённые руками, а из YCLIENTS их приехало
   * шестьдесят восемь — и почти все без кабинета. Одна такая строка запрещала
   * сохранить весь экран: изменить цену стало нельзя вообще нигде.
   *
   * Услуга без кабинета не ломает данные: в знаменателе загрузки по кабинетам
   * она просто не участвует. Поэтому не запрет, а предупреждение.
   */
  const roomless = clean.filter((s) => s.roomIds.length === 0);

  const existing = await prisma.service.findMany({
    where: { companyId },
    select: { id: true, title: true, price: true, priceLocked: true },
  });
  const submitted = clean.filter((r) => !r.id.startsWith("new-")).map((r) => r.id);
  /**
   * Удаляем только то, что было на экране при его загрузке и не вернулось.
   * Услуги, приехавшие из YCLIENTS уже после, сохранение со старой вкладки
   * снести не должно.
   */
  const removable = new Set(
    idsToDelete({ existing: existing.map((e) => e.id), submitted, known: knownIds }),
  );
  const toDelete = existing.filter((e) => removable.has(e.id));

  for (const del of toDelete) {
    /**
     * Считаем визиты по обеим связям.
     *
     * Проверялась только таблица состава визита, а она не заполнялась вовсе —
     * счёт всегда выходил нулевым, и услугу с сотней приёмов можно было
     * удалить. Визиты при этом не пропадали, но теряли услугу: в разрезе они
     * оседали строкой «без указанной услуги», и понять, что это была за
     * работа, становилось нельзя.
     */
    const [visits, primary, courses] = await Promise.all([
      prisma.appointmentService.count({ where: { serviceId: del.id } }),
      prisma.appointment.count({ where: { primaryServiceId: del.id } }),
      prisma.course.count({ where: { serviceId: del.id } }),
    ]);
    if (visits + primary + courses > 0) {
      return {
        ok: false,
        error:
          `Услугу «${del.title}» удалить нельзя: с ней связано визитов ${Math.max(visits, primary)}, ` +
          `курсов ${courses}. Деактивируйте её — история сохранится, а из списков она уйдёт.`,
      };
    }
  }

  await prisma.$transaction(async (tx) => {
    for (const del of toDelete) {
      await tx.service.delete({ where: { id: del.id } });
    }
    const before = new Map(existing.map((e) => [e.id, e]));
    for (const r of clean) {
      /**
       * Цену изменили руками — значит она наша, и выгрузка её не перепишет.
       *
       * Отметку ставим только при настоящем изменении: сохранение экрана без
       * правки цены не должно молча отвязывать услугу от YCLIENTS. Вернуть
       * цену провайдера можно кнопкой «взять из YCLIENTS».
       */
      const was = before.get(r.id);
      const priceChanged = was !== undefined && Number(was.price) !== r.price;
      /**
       * Кнопка «в YCLIENTS» вернула цену провайдера и сняла отметку — тогда
       * услуга снова обновляется выгрузкой. Иначе отметка ставится сама, как
       * только цену изменили руками, и держится, пока её не снимут.
       */
      const released =
        !r.priceLocked && r.yclientsPrice !== null && r.price === r.yclientsPrice;
      const data = {
        title: r.title.trim(),
        kind: r.kind,
        price: r.price,
        priceLocked: released ? false : priceChanged || Boolean(was?.priceLocked),
        durationMin: r.durationMin,
        isActive: r.isActive,
        isCourse: r.isCourse,
        defaultSessions: r.isCourse ? r.defaultSessions : null,
        stalledAfterDays: r.isCourse ? r.stalledAfterDays : null,
      };
      let serviceId = r.id;
      if (r.id.startsWith("new-")) {
        const created = await tx.service.create({
          data: { companyId, yclientsServiceId: null, ...data },
        });
        serviceId = created.id;
      } else {
        await tx.service.update({ where: { id: r.id }, data });
      }
      // Синхронизация кабинетов услуги.
      const current = await tx.serviceRoom.findMany({
        where: { serviceId },
        select: { roomId: true },
      });
      const currentIds = new Set(current.map((c) => c.roomId));
      const wanted = new Set(r.roomIds);
      const toRemove = [...currentIds].filter((id) => !wanted.has(id));
      const toAdd = [...wanted].filter((id) => !currentIds.has(id));
      if (toRemove.length) {
        await tx.serviceRoom.deleteMany({ where: { serviceId, roomId: { in: toRemove } } });
      }
      for (const roomId of toAdd) {
        await tx.serviceRoom.create({
          data: { companyId, serviceId, roomId },
        });
      }
    }
  },
    // Запас по времени: значение по умолчанию — пять секунд, а каждый запрос
    // к удалённой базе идёт сотни миллисекунд. Сохранение услуг
    // обрывалось бы на середине, и человек видел бы, что записалась только
    // часть. Так уже случилось с базой знаний ассистента.
    { timeout: 120_000, maxWait: 10_000 },
  );

  await writeAudit({
    companyId,
    actorId: userId,
    action: "SETTINGS_UPDATE",
    entityType: "services",
    meta: { count: clean.length, deleted: toDelete.length },
  });

  return {
    ok: true,
    payload: await getServices(),
    notice: noticeFor(roomless.length, noDuration.length),
  };
}
