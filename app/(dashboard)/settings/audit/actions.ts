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

const fmt = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
});

export async function getAuditLog(): Promise<AuditDisplayRow[]> {
  const session = await getSession();
  // Журнал доступа к карточкам пациентов — сам по себе чувствительные данные.
  await requirePermission(session, "VIEW_AUDIT");
  const rows = await prisma.auditLog.findMany({
    where: { companyId: session.companyId },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { actor: { select: { name: true } } },
  });

  return rows.map((r) => {
    const entity = ENTITY_LABEL[r.entityType] ?? r.entityType;
    const target = r.entityId ? `${entity} · ${r.entityId}` : entity;
    return {
      id: r.id,
      at: fmt.format(r.createdAt),
      actor: r.actor?.name ?? "Система",
      action: ACTION_LABEL[r.action] ?? r.action,
      target,
    };
  });
}
