/**
 * Как узнать номер у чата со скрытым идентификатором.
 *
 * WhatsApp перешёл на «…@lid»: номера в адресе чата больше нет, и вся привязка
 * пациентов по телефону перестала работать — на боевой базе без карточки
 * оказалась почти вся переписка. Номер должен отдать провайдер, но какой именно
 * метод его возвращает и в каком поле — по документации не угадать: мы на этом
 * уже обжигались с YCLIENTS.
 *
 * Скрипт спрашивает провайдера несколькими способами про реальный чат из базы и
 * печатает, что вернулось. Никаких правок — только разведка.
 *
 * Персональные данные скрыты: от номеров и адресов остаются последние четыре
 * знака, имена не печатаются.
 *
 *   npx tsx scripts/whatsapp-lid-probe.ts
 *   npx tsx scripts/whatsapp-lid-probe.ts --chat=123456789@lid
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { loadCredentials } from "../lib/integrations/whatsapp/green-api";
import { GREEN_API_BASE } from "../lib/integrations/whatsapp/config";

/** «79280001122@c.us» → «…1122@c.us». */
function mask(value: unknown): string {
  if (typeof value !== "string") return String(value);
  const at = value.indexOf("@");
  if (at === -1) return value.length > 8 ? `…${value.slice(-4)}` : value;
  return `…${value.slice(Math.max(0, at - 4), at)}${value.slice(at)}`;
}

/** Показываем форму ответа, а не содержимое: ключи и замаскированные значения. */
function shape(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) {
    return `массив из ${value.length}${value.length ? `, первый: ${shape(value[0], depth + 1)}` : ""}`;
  }
  if (typeof value === "object") {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "object" && v !== null && depth < 1) {
        parts.push(`${k}: {${shape(v, depth + 1)}}`);
        continue;
      }
      const looksLikeContact = /id|chat|phone|number|lid|sender/i.test(k);
      parts.push(`${k}: ${looksLikeContact ? mask(v) : String(v).slice(0, 20)}`);
    }
    return parts.join(", ");
  }
  return String(value).slice(0, 40);
}

async function call(path: string, body?: unknown): Promise<void> {
  const label = path.replace(/\/waInstance\d+\//, "").replace(/\/[^/]+$/, "");
  try {
    const res = await fetch(`${GREEN_API_BASE}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) {
      console.log(`\n${label}: ${res.status} ${text.slice(0, 160)}`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.log(`\n${label}: ответ не разобран — ${text.slice(0, 160)}`);
      return;
    }
    console.log(`\n${label}: ${shape(parsed)}`);
  } catch (e) {
    console.log(`\n${label}: не удалось — ${(e as Error).message}`);
  }
}

async function main() {
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const creds = await loadCredentials(company.id);
  if (!creds) {
    console.error("ключи Green API не заданы");
    await prisma.$disconnect();
    return;
  }

  const asked = process.argv.find((a) => a.startsWith("--chat="))?.split("=")[1];
  const conv =
    asked
      ? { externalUserId: asked }
      : await prisma.conversation.findFirst({
          where: { companyId: company.id, channel: "WHATSAPP", externalUserId: { contains: "@lid" } },
          orderBy: { lastMessageAt: "desc" },
          select: { externalUserId: true },
        });

  if (!conv) {
    console.log("чатов со скрытым идентификатором в базе нет");
    await prisma.$disconnect();
    return;
  }

  const chatId = conv.externalUserId;
  const { idInstance: id, apiToken: token } = creds;
  console.log(`пробуем чат ${mask(chatId)}`);

  /**
   * Способы, которыми провайдер может отдать номер. Проверяем все: какой из них
   * есть на этом тарифе и в этой версии API — видно только по ответу.
   */
  await call(`/waInstance${id}/getContactInfo/${token}`, { chatId });
  await call(`/waInstance${id}/getContacts/${token}`);
  await call(`/waInstance${id}/getChatHistory/${token}`, { chatId, count: 1 });

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("зонд упал:", e);
  await prisma.$disconnect();
  process.exit(1);
});
