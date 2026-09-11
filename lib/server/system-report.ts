import { prisma } from "@/lib/db";
import { parseDevice, KIND_LABEL, type DeviceInfo } from "@/lib/metrics/device";
import { memoryNow, type MemoryNow } from "@/lib/server/restarts";
import { screenLabel } from "@/lib/metrics/route-pattern";
import type { AuditAction } from "@/generated/prisma/enums";

/**
 * Данные раздела `/sistem`: кто, с какого устройства и что делал.
 *
 * Всё считается из того, что УЖЕ пишется. Журнал аудита с самого начала
 * хранит `userAgent` и `ip` у каждого действия — значит связь «кто, с чего,
 * что делал» в данных есть, и заводить второй поток записи ради этого экрана
 * не нужно. Это и есть ответ на «чтобы система потом не тормозила»: на горячем
 * пути не появилось ни одного нового запроса, вся работа — только здесь, при
 * открытии страницы, и только за выбранный срок.
 *
 * Устройства различаются отпечатком строки браузера. Модели аппарата там нет:
 * у всех Mac строка дословно одна и та же, у всех iPhone — тоже (подробно в
 * `lib/metrics/device.ts`). Поэтому «не учитывать этот ноутбук» делается
 * отметкой на конкретном устройстве, а не подбором по названию модели.
 */

/** За какой срок смотрим по умолчанию. */
export const SYSTEM_WINDOW_DAYS = 30;

/**
 * Сколько строк журнала разбираем максимум.
 *
 * Предел нужен не ради базы, а ради честности экрана: упёрлись в него — так и
 * пишем, а не показываем часть как целое.
 */
const MAX_ROWS = 20_000;

const ACTION_LABEL: Record<string, string> = {
  LOGIN: "вход",
  PAGE_VIEW: "открывал экран",
  LOGOUT: "выход",
  PATIENT_VIEW: "смотрел карточку пациента",
  PATIENT_EXPORT: "выгружал данные пациента",
  CONVERSATION_VIEW: "открывал переписку",
  MESSAGE_SEND: "отправлял сообщение",
  APPOINTMENT_CREATE: "заводил запись",
  APPOINTMENT_CANCEL: "отменял запись",
  SETTINGS_UPDATE: "менял настройки",
};

export interface DeviceRow {
  id: string | null;
  fingerprint: string;
  label: string;
  kindLabel: string;
  userAgent: string;
  userId: string | null;
  userName: string;
  userRole: string;
  logins: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  excluded: boolean;
  note: string | null;
  /** Действий за срок с этого устройства. */
  actions: number;
  /** Адреса, с которых заходили. Один — обычно дом или клиника. */
  ips: string[];
}

export interface PersonRow {
  userId: string | null;
  name: string;
  role: string;
  actions: number;
  logins: number;
  devices: number;
  lastSeenAt: string | null;
  /** Что делал: действие → сколько раз, от частого к редкому. */
  byAction: { label: string; count: number }[];
}

export interface DayRow {
  day: string;
  actions: number;
  logins: number;
}

export interface EventRow {
  at: string;
  userName: string;
  /** «открыл Диалоги», «открыл переписку», «менял настройки». */
  what: string;
  deviceLabel: string;
  ip: string | null;
}

export interface SystemReport {
  windowDays: number;
  /** Строк журнала разобрано; упёрлись ли в предел. */
  rows: number;
  truncated: boolean;
  devices: DeviceRow[];
  people: PersonRow[];
  days: DayRow[];
  /** Последние действия по одному — «кто и когда открывал диалог». */
  recent: EventRow[];
  /** Сколько действий скрыто отметкой «моё устройство» — молча ничего не пропадает. */
  excludedActions: number;
  excludedDevices: number;
  memory: MemoryNow;
  restarts: {
    last24h: number;
    last7d: number;
    lastAt: string | null;
    /** Память при последних запусках: по ней видно, подбирается ли к пределу. */
    recent: { at: string; rssMb: number | null }[];
  };
}

const DAY_KEY = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Europe/Moscow",
});

export async function getSystemReport(
  companyId: string,
  windowDays: number = SYSTEM_WINDOW_DAYS,
): Promise<SystemReport> {
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000);
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);

  const [audit, known, users, restarts24, restarts7, recentRestarts] = await Promise.all([
    prisma.auditLog.findMany({
      where: { companyId, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: MAX_ROWS,
      // Тел сообщений и содержимого карточек здесь нет и не запрашиваем (§7):
      // только кто, что, когда и с чего.
      select: {
        actorId: true,
        action: true,
        createdAt: true,
        userAgent: true,
        ip: true,
        // Для открытия экрана здесь лежит ОБРАЗЕЦ адреса, а не сам адрес:
        // параметры запроса в журнал не попадают (§7).
        entityType: true,
      },
    }),
    prisma.knownDevice.findMany({
      where: { companyId },
      orderBy: { lastLoginAt: "desc" },
      select: {
        id: true,
        userId: true,
        fingerprint: true,
        userAgent: true,
        label: true,
        kind: true,
        logins: true,
        firstSeenAt: true,
        lastLoginAt: true,
        excluded: true,
        note: true,
      },
    }),
    prisma.staffUser.findMany({
      where: { companyId },
      select: { id: true, name: true, role: true, isActive: true },
    }),
    prisma.appRestart.count({ where: { companyId, startedAt: { gte: dayAgo } } }),
    prisma.appRestart.count({ where: { companyId, startedAt: { gte: weekAgo } } }),
    prisma.appRestart.findMany({
      where: { companyId },
      orderBy: { startedAt: "desc" },
      take: 10,
      select: { startedAt: true, rssMb: true },
    }),
  ]);

  const userById = new Map(users.map((u) => [u.id, u]));
  const nameOf = (id: string | null) =>
    id ? (userById.get(id)?.name ?? "удалённая учётка") : "без учётки";
  const roleOf = (id: string | null) => (id ? (userById.get(id)?.role ?? "—") : "—");

  /**
   * Исключённые устройства. Ключ — пара «человек + отпечаток»: одно и то же
   * устройство у двух сотрудников это два разных устройства, и пометка одного
   * не должна скрывать работу другого.
   */
  const excludedKeys = new Set(
    known.filter((d) => d.excluded).map((d) => `${d.userId}|${d.fingerprint}`),
  );

  const deviceInfo = new Map<string, DeviceInfo>();
  const infoFor = (ua: string | null): DeviceInfo => {
    const key = ua ?? "";
    const cached = deviceInfo.get(key);
    if (cached) return cached;
    const parsed = parseDevice(ua);
    deviceInfo.set(key, parsed);
    return parsed;
  };

  interface Bucket {
    actions: number;
    logins: number;
    lastAt: Date | null;
    ips: Set<string>;
    byAction: Map<string, number>;
  }
  const empty = (): Bucket => ({
    actions: 0,
    logins: 0,
    lastAt: null,
    ips: new Set(),
    byAction: new Map(),
  });

  const byDevice = new Map<string, Bucket>();
  const byPerson = new Map<string, Bucket>();
  const byDay = new Map<string, { actions: number; logins: number }>();
  let excludedActions = 0;

  for (const row of audit) {
    const info = infoFor(row.userAgent);
    const key = `${row.actorId}|${info.fingerprint}`;
    if (excludedKeys.has(key)) {
      excludedActions += 1;
      continue;
    }

    const dev = byDevice.get(key) ?? empty();
    const person = byPerson.get(row.actorId ?? "—") ?? empty();
    const action = row.action as AuditAction;
    for (const b of [dev, person]) {
      b.actions += 1;
      if (action === "LOGIN") b.logins += 1;
      if (!b.lastAt || row.createdAt > b.lastAt) b.lastAt = row.createdAt;
      if (row.ip) b.ips.add(row.ip);
      b.byAction.set(action, (b.byAction.get(action) ?? 0) + 1);
    }
    byDevice.set(key, dev);
    byPerson.set(row.actorId ?? "—", person);

    const day = DAY_KEY.format(row.createdAt);
    const d = byDay.get(day) ?? { actions: 0, logins: 0 };
    d.actions += 1;
    if (action === "LOGIN") d.logins += 1;
    byDay.set(day, d);
  }

  /**
   * Список устройств — объединение двух источников.
   *
   * Заведённые при входе показываются даже без единого действия: «зашёл и
   * ничего не делал» — тоже ответ. Замеченные только в журнале (входы до
   * появления этого учёта) показываются тоже, иначе история выглядела бы
   * пустой там, где она есть.
   */
  const devices: DeviceRow[] = [];
  const seen = new Set<string>();

  for (const d of known) {
    const key = `${d.userId}|${d.fingerprint}`;
    seen.add(key);
    const b = byDevice.get(key);
    devices.push({
      id: d.id,
      fingerprint: d.fingerprint,
      label: d.label,
      kindLabel: KIND_LABEL[d.kind as DeviceInfo["kind"]] ?? d.kind,
      userAgent: d.userAgent,
      userId: d.userId,
      userName: nameOf(d.userId),
      userRole: roleOf(d.userId),
      logins: d.logins,
      firstSeenAt: d.firstSeenAt.toISOString(),
      lastSeenAt: (b?.lastAt ?? d.lastLoginAt).toISOString(),
      excluded: d.excluded,
      note: d.note,
      actions: b?.actions ?? 0,
      ips: [...(b?.ips ?? [])].slice(0, 5),
    });
  }

  for (const [key, b] of byDevice) {
    if (seen.has(key)) continue;
    const [actorId, fingerprint] = key.split("|");
    const sample = audit.find(
      (r) => `${r.actorId}|${infoFor(r.userAgent).fingerprint}` === key,
    );
    const info = infoFor(sample?.userAgent ?? null);
    devices.push({
      id: null,
      fingerprint,
      label: info.label,
      kindLabel: KIND_LABEL[info.kind],
      userAgent: sample?.userAgent ?? "",
      userId: actorId === "null" ? null : actorId,
      userName: nameOf(actorId === "null" ? null : actorId),
      userRole: roleOf(actorId === "null" ? null : actorId),
      logins: b.logins,
      firstSeenAt: null,
      lastSeenAt: b.lastAt?.toISOString() ?? null,
      excluded: false,
      note: null,
      actions: b.actions,
      ips: [...b.ips].slice(0, 5),
    });
  }

  devices.sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""));

  const people: PersonRow[] = [...byPerson.entries()]
    .map(([id, b]) => {
      const userId = id === "—" || id === "null" ? null : id;
      return {
        userId,
        name: nameOf(userId),
        role: roleOf(userId),
        actions: b.actions,
        logins: b.logins,
        devices: devices.filter((d) => d.userId === userId && d.actions > 0).length,
        lastSeenAt: b.lastAt?.toISOString() ?? null,
        byAction: [...b.byAction.entries()]
          .sort((x, y) => y[1] - x[1])
          .map(([action, count]) => ({ label: ACTION_LABEL[action] ?? action, count })),
      };
    })
    .sort((a, b) => b.actions - a.actions);

  /**
   * Учётки, не заходившие ни разу, тоже в списке.
   *
   * Пустая строка отвечает на свой вопрос: человеку завели доступ, а он им не
   * пользуется. Без неё такие учётки просто не видны, и заметить их можно
   * только случайно.
   */
  for (const u of users) {
    if (people.some((p) => p.userId === u.id)) continue;
    people.push({
      userId: u.id,
      name: u.name,
      role: u.role,
      actions: 0,
      logins: 0,
      devices: 0,
      lastSeenAt: null,
      byAction: [],
    });
  }

  /**
   * Последние действия по одному.
   *
   * Сводка отвечает «сколько», а разбирают всегда конкретный случай: кто
   * открывал эту переписку и когда. Берём последние сто — больше на экране
   * всё равно не читают, а срок переключается кнопками выше.
   */
  const recent: EventRow[] = audit
    .filter((r) => !excludedKeys.has(`${r.actorId}|${infoFor(r.userAgent).fingerprint}`))
    .slice(0, 100)
    .map((r) => {
      const action = r.action as AuditAction;
      const what =
        action === "PAGE_VIEW"
          ? `открыл: ${screenLabel(r.entityType)}`
          : (ACTION_LABEL[action] ?? action);
      return {
        at: r.createdAt.toISOString(),
        userName: nameOf(r.actorId),
        what,
        deviceLabel: infoFor(r.userAgent).label,
        ip: r.ip,
      };
    });

  const days: DayRow[] = [...byDay.entries()]
    .map(([day, v]) => ({ day, ...v }))
    .sort((a, b) => a.day.localeCompare(b.day));

  return {
    windowDays,
    rows: audit.length,
    truncated: audit.length >= MAX_ROWS,
    devices,
    people,
    days,
    recent,
    excludedActions,
    excludedDevices: excludedKeys.size,
    memory: memoryNow(),
    restarts: {
      last24h: restarts24,
      last7d: restarts7,
      lastAt: recentRestarts[0]?.startedAt.toISOString() ?? null,
      recent: recentRestarts.map((r) => ({ at: r.startedAt.toISOString(), rssMb: r.rssMb })),
    },
  };
}
