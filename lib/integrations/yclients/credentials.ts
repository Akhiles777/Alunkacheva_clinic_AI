import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";

/**
 * Токены YCLIENTS хранятся зашифрованными в таблице Credential (раздел настроек
 * «Интеграции»). Здесь — единственная точка их расшифровки для серверных
 * вызовов. Наружу (в логи, в ответы) расшифрованные значения не отдаём.
 */
export interface YclientsCredentials {
  partnerToken: string;
  userToken: string;
  companyId: string;
}

const PROVIDER = "yclients";

export async function loadYclientsCredentials(companyId: string): Promise<YclientsCredentials | null> {
  const rows = await prisma.credential.findMany({
    where: { companyId, provider: PROVIDER },
    select: { keyName: true, valueEncrypted: true },
  });
  const byKey = new Map(rows.map((r) => [r.keyName, r.valueEncrypted]));
  const partner = byKey.get("partner_token");
  const user = byKey.get("user_token");
  const company = byKey.get("company_id");
  if (!partner || !user || !company) return null;

  try {
    return {
      partnerToken: decryptSecret(partner),
      userToken: decryptSecret(user),
      companyId: decryptSecret(company),
    };
  } catch {
    // Повреждённый шифртекст или сменившийся мастер-ключ — считаем не настроенным.
    return null;
  }
}

/** Заголовок авторизации YCLIENTS: партнёрский + пользовательский токен. */
export function authHeader(creds: YclientsCredentials): string {
  return `Bearer ${creds.partnerToken}, User ${creds.userToken}`;
}
