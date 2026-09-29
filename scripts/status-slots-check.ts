/**
 * Окошки из статусов WhatsApp: всё ли готово, чтобы агент их закреплял.
 *
 * Закрепление держится на трёх вещах, и каждую проверить можно только на
 * боевом аккаунте:
 *
 *   1. Номер клиники. По нему агент узнаёт, что пациент отвечает на статус
 *      КЛИНИКИ, а не на собственное сообщение. Не узнали — окошко не
 *      закрепляется, а передаётся администратору.
 *   2. Время публикации статуса. «Окошко на завтра» без него — это сегодня или
 *      завтра, и агент переспрашивает день. Время приходит вебхуком (статус,
 *      выложенный с телефона) или запросом к провайдеру (методы статусов у
 *      Green API помечены как бета).
 *   3. Что уже закреплено: какие окошки агент пообещал и ждут записи.
 *
 * Скрипт ничего не меняет и никому не пишет — только читает базу и спрашивает
 * провайдера.
 *
 *   npx tsx scripts/status-slots-check.ts
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { fetchOutgoingStatuses, instanceState, instanceWid } from "../lib/integrations/whatsapp/green-api";
import { isWhatsappEnabled } from "../lib/integrations/whatsapp/config";
import { looksLikeOffer, parseStatusOffer } from "../lib/agent/status-slot";

const WHEN = (d: Date) =>
  new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(d);

/** Номер в журнал — только хвост: целиком это персональные данные (§7). */
const tail = (wid: string) => `…${wid.split("@")[0].slice(-4)}@${wid.split("@")[1] ?? ""}`;

async function main() {
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  console.log(`клиника: ${company.name}\n`);

  console.log("── WHATSAPP");
  if (!isWhatsappEnabled()) {
    console.log("  интеграция выключена (WHATSAPP_ENABLED) — дальше проверять нечего");
    return;
  }
  const state = await instanceState(company.id).catch(() => null);
  console.log(`  состояние: ${state ? `${state.state} — ${state.hint}` : "провайдер не ответил"}`);

  console.log("\n── 1. НОМЕР КЛИНИКИ");
  const wid = await instanceWid(company.id).catch(() => null);
  console.log(
    wid
      ? `  узнан: ${tail(wid)} — ответы на статусы клиники будут узнаваться`
      : "  НЕ УЗНАН: провайдер не отдал wid. Окошки не будут закрепляться — только передаваться администратору.",
  );

  console.log("\n── 2. СТАТУСЫ И ВРЕМЯ ПУБЛИКАЦИИ");
  const staff = await prisma.staff.findMany({
    where: { companyId: company.id, isActive: true, deletedAt: null },
    select: { id: true, name: true },
  });
  const since = new Date(Date.now() - 7 * 86_400_000);
  const saved = await prisma.clinicStatus.findMany({
    where: { companyId: company.id, postedAt: { gte: since } },
    orderBy: { postedAt: "desc" },
    take: 10,
  });
  const byWebhook = saved.filter((s) => s.source === "webhook").length;
  console.log(`  за неделю сохранено: ${saved.length} (вебхуком ${byWebhook}, запросом ${saved.length - byWebhook})`);
  if (byWebhook === 0) {
    console.log(
      "  вебхуком статусы не приходили. Если статусы выкладывались — провайдер их не присылает, " +
        "и время публикации берётся только запросом (п. ниже).",
    );
  }

  const fetched = await fetchOutgoingStatuses(company.id, 26 * 60).catch(() => null);
  if (fetched === null) {
    console.log(
      "  запрос статусов у провайдера НЕ РАБОТАЕТ (метод недоступен на тарифе или сбой). " +
        "Если и вебхуком их нет — «окошко на завтра» агент будет уточнять у пациента.",
    );
  } else {
    console.log(`  запрос статусов работает: за сутки ${fetched.length}`);
  }

  const shown = [...saved.map((s) => ({ text: s.text, at: s.postedAt })), ...(fetched ?? []).map((s) => ({ text: s.text, at: s.postedAt }))]
    .filter((s, i, all) => all.findIndex((x) => x.text === s.text && x.at.getTime() === s.at.getTime()) === i)
    .slice(0, 8);
  for (const s of shown) {
    const offer = parseStatusOffer(s.text, staff);
    const verdict = !looksLikeOffer(s.text)
      ? "не окошко"
      : !offer?.staff
        ? offer?.staffAmbiguous
          ? "окошко, врач неоднозначен — будет передаваться администратору"
          : "окошко без врача — будет передаваться администратору"
        : `окошко: ${offer.staff.name}, время ${offer.times.map((m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`).join(", ")}`;
    console.log(`  ${WHEN(s.at)} · «${s.text.slice(0, 80)}» → ${verdict}`);
  }

  console.log("\n── 3. ЗАКРЕПЛЁННЫЕ ОКОШКИ");
  const held = await prisma.slotHold.findMany({
    where: { companyId: company.id, state: "HELD", startAt: { gt: new Date() } },
    orderBy: { startAt: "asc" },
    take: 20,
    select: { startAt: true, staffId: true, heldAt: true, conversationId: true },
  });
  if (held.length === 0) console.log("  впереди нет ни одного");
  for (const h of held) {
    const who = staff.find((s) => s.id === h.staffId)?.name ?? "врач не найден";
    const booked = await prisma.appointment.count({
      where: { companyId: company.id, staffId: h.staffId, startAt: h.startAt, deletedAt: null, status: { not: "CANCELLED" } },
    });
    console.log(
      `  ${WHEN(h.startAt)} · ${who} · закреплено ${h.heldAt ? WHEN(h.heldAt) : "?"} · ` +
        (booked > 0 ? "запись в YCLIENTS есть" : "ЗАПИСИ В YCLIENTS ЕЩЁ НЕТ — оформить"),
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
