/**
 * Как агент вёл конкретный диалог — по фактам из базы, а не по догадкам.
 *
 * Разбор живых жалоб шёл вслепую: в песочнице разговор проходит правильно, а на
 * боевом сервере тот же разговор обрывается, потому что у диалога там другое
 * состояние — подтянутая история с телефона, эхо ответов, реплики сотрудников,
 * уже данное согласие. Скрипт показывает это состояние целиком.
 *
 * Тексты пациента не печатаются (§7): только кто, когда и что про сообщение
 * известно правилам. Тексты клиники (агента и сотрудников) — первые 90 знаков.
 *
 *   npx tsx scripts/dialog-state.ts --phone=+79886433053
 *
 * Тексты целиком и судьбу доставки каждого ответа показывает
 * `scripts/dialog-trace.ts`; этот скрипт — про СОСТОЯНИЕ, из-за которого агент
 * повёл себя так, а не иначе.
 *
 * Ничего не меняет и никому не пишет.
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { normalizePhone } from "../lib/phone";
import { wantsToBook } from "../lib/agent/triggers";
import { staffConfirmedBooking } from "../lib/agent/booking-flow";

const WHEN = (d: Date | null | undefined) =>
  d
    ? new Intl.DateTimeFormat("ru-RU", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZone: "Europe/Moscow",
      }).format(d)
    : "—";

/** Номер принимаем и с пробелами: оболочка режет «+7 988 …» на части. */
function phoneArg(): string | null {
  const argv = process.argv.slice(2);
  const at = argv.findIndex((a) => a.startsWith("--phone="));
  if (at < 0) return null;
  const rest = argv.slice(at + 1);
  const end = rest.findIndex((a) => a.startsWith("--"));
  return [argv[at].slice("--phone=".length), ...(end < 0 ? rest : rest.slice(0, end))].join(" ").trim() || null;
}

const key = (t: string) => t.replace(/\s+/g, " ").trim();
const short = (t: string) => {
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > 90 ? `${one.slice(0, 90)}…` : one;
};

async function main() {
  const raw = phoneArg();
  const e164 = raw ? normalizePhone(raw) : null;
  if (!e164) {
    console.log("Укажите номер: --phone=+79886433053");
    return;
  }
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const digits = e164.replace(/\D/g, "");
  const conv = await prisma.conversation.findFirst({
    where: {
      companyId: company.id,
      OR: [{ externalUserId: `${digits}@c.us` }, { patient: { phones: { some: { phone: e164 } } } }],
    },
    orderBy: { lastMessageAt: "desc" },
    select: {
      id: true,
      channel: true,
      status: true,
      agentDisabled: true,
      botPausedUntil: true,
      consentAskedAt: true,
      consentGrantedAt: true,
      historyImportedAt: true,
      patientId: true,
    },
  });
  if (!conv) {
    console.log("Диалога с этим номером нет.");
    return;
  }

  const visits = conv.patientId
    ? await prisma.appointment.count({ where: { patientId: conv.patientId, deletedAt: null } })
    : 0;
  console.log("── ДИАЛОГ");
  console.log(`  канал ${conv.channel} · статус ${conv.status}${conv.agentDisabled ? " · АГЕНТ ВЫКЛЮЧЕН" : ""}`);
  console.log(`  пауза агента до: ${WHEN(conv.botPausedUntil)}`);
  console.log(`  согласие: спрошено ${WHEN(conv.consentAskedAt)} · дано ${WHEN(conv.consentGrantedAt)}`);
  console.log(`  карточка пациента: ${conv.patientId ? `есть, визитов ${visits}` : "не привязана"}`);
  console.log(`  история с телефона подтянута: ${WHEN(conv.historyImportedAt)}`);

  const messages = (
    await prisma.message.findMany({
      where: { conversationId: conv.id, deletedAt: null, isDraft: false },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: { createdAt: true, direction: true, authorType: true, status: true, body: true, failureReason: true },
    })
  ).reverse();
  const botBodies = messages.filter((m) => m.authorType === "BOT").map((m) => ({ at: m.createdAt, key: key(m.body) }));

  console.log("\n── СООБЩЕНИЯ (последние 40)");
  for (const m of messages) {
    if (m.direction === "IN") {
      const flags = [wantsToBook(m.body) ? "просьба записать" : null].filter(Boolean);
      console.log(`  ${WHEN(m.createdAt)} · пациент · ${m.body.length} зн.${flags.length ? ` · ${flags.join(", ")}` : ""}`);
      continue;
    }
    const who = m.authorType === "BOT" ? "агент" : "сотрудник";
    const flags: string[] = [];
    if (m.authorType === "STAFF") {
      const echo = botBodies.some(
        (b) => b.key === key(m.body) && Math.abs(b.at.getTime() - m.createdAt.getTime()) < 15 * 60_000,
      );
      if (echo) flags.push("ЭХО ОТВЕТА АГЕНТА, записано сотрудником");
      if (staffConfirmedBooking(m.body)) flags.push("запись оформлена");
    }
    if (m.status === "FAILED") flags.push(`НЕ ДОСТАВЛЕНО: ${m.failureReason ?? "причина не записана"}`);
    console.log(`  ${WHEN(m.createdAt)} · ${who}${flags.length ? ` · ${flags.join(" · ")}` : ""}`);
    console.log(`      «${short(m.body)}»`);
  }

  const escalations = await prisma.escalation.findMany({
    where: { conversationId: conv.id },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { createdAt: true, reason: true, reasonText: true, status: true },
  });
  console.log("\n── ЭСКАЛАЦИИ");
  if (escalations.length === 0) console.log("  нет");
  for (const e of escalations.reverse()) {
    console.log(`  ${WHEN(e.createdAt)} · ${e.reason} · ${e.status} · ${e.reasonText ?? ""}`);
  }

  const runs = await prisma.agentRun.findMany({
    where: { conversationId: conv.id },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { createdAt: true, outcome: true, errorText: true },
  });
  console.log("\n── ПОПЫТКИ АГЕНТА (журнал)");
  if (runs.length === 0) console.log("  нет");
  for (const r of runs.reverse()) {
    console.log(`  ${WHEN(r.createdAt)} · ${r.outcome}${r.errorText ? ` · ${r.errorText}` : ""}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
