"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";

export interface AuditDisplayRow {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  /** Откуда сделано: устройство и адрес. «—», если запись старая. */
  device: string;
  ip: string;
}

/** Узнаваемое имя устройства из user-agent: без версий и служебных строк. */
function deviceLabel(agent: string | null): string {
  if (!agent) return "—";
  const browser = /Firefox/i.test(agent)
    ? "Firefox"
    : /Edg/i.test(agent)
      ? "Edge"
      : /Chrome|CriOS/i.test(agent)
        ? "Chrome"
        : /Safari/i.test(agent)
          ? "Safari"
          : "Браузер";
  const os = /iPhone|iPad/i.test(agent)
    ? "iPhone"
    : /Android/i.test(agent)
      ? "Android"
      : /Macintosh/i.test(agent)
        ? "Mac"
        : /Windows/i.test(agent)
          ? "Windows"
          : "";
  return os ? `${browser} · ${os}` : browser;
}

const ACTION_LABEL: Record<string, string> = {
  LOGIN: "Вход",
  LOGOUT: "Выход",
  PATIENT_VIEW: "Просмотр карточки",
  PATIENT_EXPORT: "Экспорт данных пациента",
  CONVERSATION_VIEW: "Просмотр диалога",
  MESSAGE_SEND: "Отправка сообщения",
  APPOINTMENT_CREATE: "Создание записи",
  APPOINTMENT_CANCEL: "Отмена записи",
  SETTINGS_UPDATE: "Изменение настроек",
};

const ENTITY_LABEL: Record<string, string> = {
  clinic: "Клиника",
  integrations: "Интеграции",
  sources: "Источники",
  services: "Услуги",
  rooms: "Кабинеты",
  assistant: "Ассистент",
  templates: "Шаблоны",
  notifications: "Уведомления",
  consent: "Согласие",
  roles: "Матрица прав",
  "role-matrix": "Матрица прав",
};

/**
 * Время — в зоне клиники, а не сервера. Без указания зоны формат брал
 * настройку хостинга (на Vercel это UTC), и действие, сделанное в 10:36 по
 * Москве, показывалось как «07:36» — владелец искал, кто работал в системе
 * в семь утра.
 */
const fmt = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});

export async function getAuditLog(): Promise<AuditDisplayRow[]> {
  const session = await getSession();
  // Журнал доступа к карточкам пациентов — сам по себе чувствительные данные.
  await requirePermission(session, "VIEW_AUDIT");
  const rows = await prisma.auditLog.findMany({
    where: { companyId: session.companyId },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { actor: { select: { name: true, login: true } } },
  });

  return rows.map((r) => {
    const entity = ENTITY_LABEL[r.entityType] ?? r.entityType;
    const target = r.entityId ? `${entity} · ${r.entityId}` : entity;
    return {
      id: r.id,
      at: fmt.format(r.createdAt),
      actor: r.actor ? `${r.actor.name} (${r.actor.login})` : "Система",
      action: ACTION_LABEL[r.action] ?? r.action,
      target,
      device: deviceLabel(r.userAgent),
      ip: r.ip ?? "—",
    };
  });
}
