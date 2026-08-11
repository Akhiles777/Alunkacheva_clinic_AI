import { prisma } from "@/lib/db";
import { getYclientsClient, type YclientsClientHandle } from "./client";
import { apiDate, hasNextPage, monthWindows, PAGE_SIZE } from "./paging";
import { HISTORY_YEARS } from "./config";
import type {
  YclientsClient as YclientsClientDto,
  YclientsRecord,
  YclientsResource,
  YclientsService,
  YclientsStaff,
} from "./types";

/**
 * Сверка выгрузки: сколько сущностей в YCLIENTS и сколько у нас.
 *
 * Утверждать «выгрузка полная, расхождений нет» можно только предъявив
 * сравнение. Молчаливая синхронизация без сверки — это надежда, а не факт:
 * пропущенная страница или неудачно легший диапазон дат выглядят точно так же,
 * как успешный прогон.
 *
 * Отчёт показывает не только числа, но и конкретные идентификаторы, которых не
 * хватает: по ним видно, что именно потерялось.
 */

export interface EntityDiff {
  entity: string;
  /** Сколько записей в YCLIENTS. */
  remote: number;
  /** Сколько у нас с проставленным внешним идентификатором. */
  local: number;
  /** Есть у них, нет у нас — то, что не доехало. */
  missingLocally: number[];
  /** Есть у нас с их идентификатором, но у них уже нет — удалили после выгрузки. */
  staleLocally: number[];
  /** Совпадает ли количество и состав. */
  ok: boolean;
  /** Пояснение, если сверить не удалось. */
  note?: string;
}

export interface ReconcileReport {
  checkedAt: string;
  /** Интеграция выключена или нет ключей — сверять нечего. */
  skipped: boolean;
  entities: EntityDiff[];
  /** Локальные визиты, не отправленные в YCLIENTS. */
  notPushed: number;
  /** Визиты, которые YCLIENTS отказался принять: слот занят. */
  conflicts: number;
  ok: boolean;
}

/**
 * Сравнение двух наборов идентификаторов. Вынесено отдельно: это ядро сверки,
 * и ошибка здесь означала бы ложное «всё сошлось».
 */
export function diffIds(
  remote: number[],
  local: number[],
): { missingLocally: number[]; staleLocally: number[] } {
  const remoteSet = new Set(remote);
  const localSet = new Set(local);
  return {
    missingLocally: [...remoteSet].filter((id) => !localSet.has(id)).sort((a, b) => a - b),
    staleLocally: [...localSet].filter((id) => !remoteSet.has(id)).sort((a, b) => a - b),
  };
}

/** Сводит числа и списки в готовую строку отчёта. */
export function buildDiff(entity: string, remote: number[], local: number[]): EntityDiff {
  const { missingLocally, staleLocally } = diffIds(remote, local);
  return {
    entity,
    remote: new Set(remote).size,
    local: new Set(local).size,
    // В отчёт кладём первые двадцать: полный список из тысячи номеров
    // невозможно прочитать, а понять масштаб хватает и этого.
    missingLocally: missingLocally.slice(0, 20),
    staleLocally: staleLocally.slice(0, 20),
    ok: missingLocally.length === 0 && staleLocally.length === 0,
  };
}

export async function reconcile(companyId: string): Promise<ReconcileReport> {
  const client = await getYclientsClient(companyId);
  const [notPushed, conflicts] = await Promise.all([
    prisma.appointment.count({
      where: { companyId, deletedAt: null, yclientsRecordId: null, startAt: { gte: new Date() } },
    }),
    prisma.appointment.count({ where: { companyId, deletedAt: null, syncState: "CONFLICT" } }),
  ]);

  if (!client) {
    return {
      checkedAt: new Date().toISOString(),
      skipped: true,
      entities: [],
      notPushed,
      conflicts,
      ok: false,
    };
  }

  const entities: EntityDiff[] = [];
  entities.push(await reconcileServices(companyId, client));
  entities.push(await reconcileStaff(companyId, client));
  entities.push(await reconcileResources(companyId, client));
  entities.push(await reconcileClients(companyId, client));
  entities.push(await reconcileRecords(companyId, client));

  return {
    checkedAt: new Date().toISOString(),
    skipped: false,
    entities,
    notPushed,
    conflicts,
    ok: entities.every((e) => e.ok) && conflicts === 0,
  };
}

async function safe(entity: string, fn: () => Promise<EntityDiff>): Promise<EntityDiff> {
  try {
    return await fn();
  } catch (e) {
    // Не смогли получить данные — это не «сошлось», а «неизвестно».
    return {
      entity,
      remote: 0,
      local: 0,
      missingLocally: [],
      staleLocally: [],
      ok: false,
      note: `Не удалось сверить: ${(e as Error).message}`.slice(0, 200),
    };
  }
}

function reconcileServices(companyId: string, client: YclientsClientHandle) {
  return safe("Услуги", async () => {
    const remote = await client.get<YclientsService[]>(
      client.endpoints.services(client.creds.companyId),
    );
    const local = await prisma.service.findMany({
      where: { companyId, yclientsServiceId: { not: null } },
      select: { yclientsServiceId: true },
    });
    return buildDiff(
      "Услуги",
      (remote ?? []).map((s) => s.id),
      local.map((s) => s.yclientsServiceId!),
    );
  });
}

function reconcileStaff(companyId: string, client: YclientsClientHandle) {
  return safe("Специалисты", async () => {
    const remote = await client.get<YclientsStaff[]>(client.endpoints.staff(client.creds.companyId));
    const local = await prisma.staff.findMany({
      where: { companyId, yclientsStaffId: { not: null }, deletedAt: null },
      select: { yclientsStaffId: true },
    });
    return buildDiff(
      "Специалисты",
      (remote ?? []).map((s) => s.id),
      local.map((s) => s.yclientsStaffId!),
    );
  });
}

function reconcileResources(companyId: string, client: YclientsClientHandle) {
  return safe("Кабинеты", async () => {
    const remote = await client.get<YclientsResource[]>(
      client.endpoints.resources(client.creds.companyId),
    );
    const local = await prisma.room.findMany({
      where: { companyId, yclientsResourceId: { not: null } },
      select: { yclientsResourceId: true },
    });
    return buildDiff(
      "Кабинеты",
      (remote ?? []).map((r) => r.id),
      local.map((r) => r.yclientsResourceId!),
    );
  });
}

function reconcileClients(companyId: string, client: YclientsClientHandle) {
  return safe("Пациенты", async () => {
    const remoteIds: number[] = [];
    let page = 1;
    for (;;) {
      const res = await client.getPage<YclientsClientDto[]>(
        client.endpoints.clients(client.creds.companyId),
        { page, count: PAGE_SIZE },
      );
      const dtos = res.data ?? [];
      remoteIds.push(...dtos.map((c) => c.id));
      if (
        !hasNextPage({
          received: dtos.length,
          pageSize: PAGE_SIZE,
          fetchedSoFar: remoteIds.length,
          totalCount: res.totalCount,
          page,
        })
      ) {
        break;
      }
      page += 1;
    }
    const local = await prisma.patient.findMany({
      where: { companyId, yclientsId: { not: null }, deletedAt: null },
      select: { yclientsId: true },
    });
    return buildDiff("Пациенты", remoteIds, local.map((p) => p.yclientsId!));
  });
}

/**
 * Записи сверяем за тот же период, что и выгружаем: сравнивать всю историю с
 * тем, что мы тянули за два года, бессмысленно — расхождение было бы ложным.
 */
function reconcileRecords(companyId: string, client: YclientsClientHandle) {
  return safe("Визиты", async () => {
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear() - HISTORY_YEARS, now.getUTCMonth(), 1));
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3, 1));

    const remoteIds: number[] = [];
    for (const window of monthWindows(from, to)) {
      let page = 1;
      let fetched = 0;
      for (;;) {
        const res = await client.getPage<YclientsRecord[]>(
          client.endpoints.records(client.creds.companyId),
          { start_date: apiDate(window.from), end_date: apiDate(window.to), page, count: PAGE_SIZE },
        );
        const dtos = res.data ?? [];
        // Удалённые в YCLIENTS в сверку не берём: у нас они помечены
        // удалёнными, и это не расхождение.
        remoteIds.push(...dtos.filter((r) => !r.deleted).map((r) => r.id));
        fetched += dtos.length;
        if (
          !hasNextPage({
            received: dtos.length,
            pageSize: PAGE_SIZE,
            fetchedSoFar: fetched,
            totalCount: res.totalCount,
            page,
          })
        ) {
          break;
        }
        page += 1;
      }
    }

    const local = await prisma.appointment.findMany({
      where: {
        companyId,
        deletedAt: null,
        yclientsRecordId: { not: null },
        startAt: { gte: from, lt: to },
      },
      select: { yclientsRecordId: true },
    });
    return buildDiff("Визиты", remoteIds, local.map((a) => a.yclientsRecordId!));
  });
}
