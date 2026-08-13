"use server";

import { prisma } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import { writeAudit } from "@/lib/server/audit";

/**
 * Серверная часть интеграций. Секреты шифруются здесь (AES-256-GCM, мастер-ключ
 * из env) и кладутся в таблицу Credential. Наружу — только факт «задано» и
 * статус связи; открытое значение не покидает сервер и не пишется в лог.
 */
export type ProviderId = "yclients" | "instagram" | "whatsapp";

const PROVIDERS: {
  provider: ProviderId;
  title: string;
  fields: { keyName: string; label: string }[];
}[] = [
  {
    provider: "yclients",
    title: "YCLIENTS",
    fields: [
      { keyName: "partner_token", label: "Партнёрский токен" },
      { keyName: "user_token", label: "Пользовательский токен" },
      { keyName: "company_id", label: "ID филиала" },
    ],
  },
  { provider: "instagram", title: "Instagram", fields: [{ keyName: "page_token", label: "Токен страницы" }] },
  {
    provider: "whatsapp",
    title: "WhatsApp (Green API)",
    fields: [
      { keyName: "id_instance", label: "idInstance" },
      { keyName: "api_token", label: "apiTokenInstance" },
    ],
  },
];

export interface IntegrationView {
  provider: ProviderId;
  title: string;
  status: "unknown" | "ok" | "failed";
  lastCheckedAt: string | null;
  fields: { keyName: string; label: string; set: boolean }[];
}

function fmtWhen(d: Date | null): string | null {
  if (!d) return null;
  return d.toLocaleString("ru-RU", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  });
}

async function buildView(companyId: string): Promise<IntegrationView[]> {
  const creds = await prisma.credential.findMany({
    where: { companyId },
    select: { provider: true, keyName: true, status: true, lastCheckedAt: true },
  });
  const byKey = new Map(creds.map((c) => [`${c.provider}:${c.keyName}`, c]));

  return PROVIDERS.map((p) => {
    const fields = p.fields.map((f) => ({
      keyName: f.keyName,
      label: f.label,
      set: byKey.has(`${p.provider}:${f.keyName}`),
    }));
    const rows = creds.filter((c) => c.provider === p.provider);
    const lastChecked = rows
      .map((r) => r.lastCheckedAt)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    // Статус блока: все ключи заданы и последняя проверка не FAILED.
    let status: IntegrationView["status"] = "unknown";
    if (fields.every((f) => f.set) && rows.length > 0) {
      status = rows.some((r) => r.status === "FAILED") ? "failed" : rows.some((r) => r.status === "OK") ? "ok" : "unknown";
    } else if (rows.some((r) => r.status === "FAILED")) {
      status = "failed";
    }
    return { provider: p.provider, title: p.title, status, lastCheckedAt: fmtWhen(lastChecked), fields };
  });
}

export async function getIntegrations(): Promise<IntegrationView[]> {
  const session = await getSession();
  return buildView(session.companyId);
}

export async function saveCredential(
  provider: ProviderId,
  keyName: string,
  plaintext: string,
): Promise<IntegrationView[]> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");

  const valueEncrypted = encryptSecret(plaintext);
  await prisma.credential.upsert({
    where: { companyId_provider_keyName: { companyId: session.companyId, provider, keyName } },
    update: { valueEncrypted, status: "UNKNOWN", lastCheckedAt: null },
    create: { companyId: session.companyId, provider, keyName, valueEncrypted, status: "UNKNOWN" },
  });
  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "credential",
    entityId: `${provider}:${keyName}`,
  });
  return buildView(session.companyId);
}

export async function checkConnection(provider: ProviderId): Promise<IntegrationView[]> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");

  const required = PROVIDERS.find((p) => p.provider === provider)?.fields.map((f) => f.keyName) ?? [];
  const rows = await prisma.credential.findMany({
    where: { companyId: session.companyId, provider },
    select: { keyName: true },
  });
  const ok = required.every((k) => rows.some((r) => r.keyName === k));

  await prisma.credential.updateMany({
    where: { companyId: session.companyId, provider },
    data: { status: ok ? "OK" : "FAILED", lastCheckedAt: new Date() },
  });
  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "credential-check",
    entityId: provider,
    meta: { ok },
  });
  return buildView(session.companyId);
}
