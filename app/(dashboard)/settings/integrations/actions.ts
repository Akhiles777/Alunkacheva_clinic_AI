"use server";

import { prisma } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import { writeAudit } from "@/lib/server/audit";
import { decryptSecret } from "@/lib/crypto";
import { fetchBranches, fetchUserToken, type YclientsBranch } from "@/lib/integrations/yclients/auth";

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

/** Расшифрованное значение одного ключа. Наружу не отдаётся никогда. */
async function secret(companyId: string, provider: ProviderId, keyName: string): Promise<string | null> {
  const row = await prisma.credential.findUnique({
    where: { companyId_provider_keyName: { companyId, provider, keyName } },
    select: { valueEncrypted: true },
  });
  if (!row) return null;
  try {
    return decryptSecret(row.valueEncrypted);
  } catch {
    return null;
  }
}

async function put(companyId: string, provider: ProviderId, keyName: string, value: string) {
  const valueEncrypted = encryptSecret(value);
  await prisma.credential.upsert({
    where: { companyId_provider_keyName: { companyId, provider, keyName } },
    update: { valueEncrypted, status: "OK", lastCheckedAt: new Date() },
    create: { companyId, provider, keyName, valueEncrypted, status: "OK", lastCheckedAt: new Date() },
  });
}

export interface ConnectResult {
  ok: boolean;
  error?: string;
  /** Филиалы на выбор. Один — выбран сам; несколько — выбирает человек. */
  branches?: YclientsBranch[];
  selectedBranchId?: number;
  view: IntegrationView[];
}

/**
 * Подключение к YCLIENTS логином и паролем сотрудника клиники.
 *
 * Партнёрского токена одного мало: API отвечает «Не указаны авторизационные
 * данные». Пользовательский токен выдаётся в обмен на логин и пароль, и
 * раньше получить его можно было только запросом руками с последующей записью
 * в базу. Теперь это кнопка в настройках.
 *
 * Логин и пароль не сохраняются нигде: они живут ровно один запрос. В базу
 * ложится только выданный токен, зашифрованным.
 */
export async function connectYclients(login: string, password: string): Promise<ConnectResult> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");

  const view = async () => buildView(session.companyId);

  const partner = await secret(session.companyId, "yclients", "partner_token");
  if (!partner) {
    return { ok: false, error: "Сначала сохраните партнёрский токен", view: await view() };
  }
  if (!login.trim() || !password) {
    return { ok: false, error: "Укажите логин и пароль YCLIENTS", view: await view() };
  }

  const auth = await fetchUserToken(partner, login.trim(), password);
  if (!auth.ok || !auth.userToken) {
    return { ok: false, error: auth.error ?? "Не удалось войти в YCLIENTS", view: await view() };
  }
  await put(session.companyId, "yclients", "user_token", auth.userToken);

  const branches = await fetchBranches(partner, auth.userToken);
  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "credential",
    // Ни логина, ни пароля, ни токена в журнале: только факт подключения.
    entityId: "yclients:connect",
  });

  if (!branches.ok || !branches.branches) {
    return { ok: true, error: branches.error, view: await view() };
  }

  /**
   * Единственный филиал выбираем сами: заставлять выбирать из списка в одну
   * строку — лишний шаг. Если филиалов несколько, выбирает человек: ошибка
   * здесь означает выгрузку из чужой клиники.
   */
  if (branches.branches.length === 1) {
    await put(session.companyId, "yclients", "company_id", String(branches.branches[0].id));
    return {
      ok: true,
      branches: branches.branches,
      selectedBranchId: branches.branches[0].id,
      view: await view(),
    };
  }
  return { ok: true, branches: branches.branches, view: await view() };
}

/** Выбор филиала, когда их несколько. */
export async function selectYclientsBranch(branchId: number): Promise<IntegrationView[]> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");
  await put(session.companyId, "yclients", "company_id", String(branchId));
  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "credential",
    entityId: "yclients:company_id",
    meta: { branchId },
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
  const filled = required.every((k) => rows.some((r) => r.keyName === k));

  /**
   * Заполненность полей — не проверка связи.
   *
   * Раньше кнопка только считала ключи и рисовала «OK». Токен мог быть
   * просроченным, филиал — чужим, и узнали бы мы об этом на выгрузке, когда
   * поздно. Для YCLIENTS делаем настоящий запрос: если он вернул филиалы,
   * связь есть.
   */
  let ok = filled;
  if (provider === "yclients" && filled) {
    const partner = await secret(session.companyId, "yclients", "partner_token");
    const user = await secret(session.companyId, "yclients", "user_token");
    ok = false;
    if (partner && user) {
      const branches = await fetchBranches(partner, user);
      ok = branches.ok;
    }
  }

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
