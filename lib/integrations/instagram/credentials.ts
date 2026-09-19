import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { INSTAGRAM_PROVIDER } from "./config";

/**
 * Ключи Instagram — в таблице Credential, зашифрованными, как у остальных
 * интеграций («Настройки → Интеграции»).
 *
 * Прежде секрет приложения и слово проверки жили в .env: сменить их можно было
 * только по ssh, а на экране было видно лишь «задано / не задано». В окружении
 * остались рубильник и то, что относится к серверу, а не к клинике: адрес
 * прокси и общий с ним секрет.
 */
export type InstagramKey = "page_token" | "app_secret" | "verify_token";

export async function instagramKey(
  companyId: string,
  keyName: InstagramKey,
): Promise<string | null> {
  const row = await prisma.credential.findFirst({
    where: { companyId, provider: INSTAGRAM_PROVIDER, keyName },
    select: { valueEncrypted: true },
  });
  if (!row) return null;
  try {
    return decryptSecret(row.valueEncrypted).trim() || null;
  } catch {
    // Сменившийся мастер-ключ или повреждённый шифртекст — считаем ненастроенным.
    return null;
  }
}

/**
 * Клиника-адресат события Meta: та, у которой заведены ключи Instagram. При
 * неоднозначности — самая ранняя, как и во всём остальном интерфейсе.
 * Требовать «ровно одну клинику» нельзя: лишняя строка в таблице однажды уже
 * стоила потерянных сообщений в WhatsApp.
 */
export async function resolveInstagramCompany(): Promise<string | null> {
  const configured = await prisma.credential.findMany({
    where: { provider: INSTAGRAM_PROVIDER },
    distinct: ["companyId"],
    select: { companyId: true },
    take: 2,
  });
  if (configured.length === 1) return configured[0].companyId;

  const oldest = await prisma.company.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return oldest?.id ?? null;
}

/** Клиники, у которых Instagram заведён, — им и уведомление о сбое прокси. */
export async function instagramCompanies(): Promise<string[]> {
  const rows = await prisma.credential.findMany({
    where: { provider: INSTAGRAM_PROVIDER, keyName: "page_token" },
    distinct: ["companyId"],
    select: { companyId: true },
  });
  return rows.map((r) => r.companyId);
}
