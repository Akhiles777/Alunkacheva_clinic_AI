/**
 * Поправка тем, кому агент ошибочно отказал по возрасту.
 *
 * Живой диалог 2 октября: «Хотела записать месячного ребенка на приём» → «К
 * сожалению, остеопатический приём для детей начинается с более старшего
 * возраста». Клиника принимает детей с первого месяца жизни. Причину закрыли в
 * коде (lib/agent/age-limit), но человек, получивший отказ, о правке не узнает:
 * он считает, что ему отказали, и ищет другую клинику.
 *
 * Скрипт находит такие диалоги и, если после отказа никто не писал — ни
 * пациент, ни сотрудник, — отправляет поправку и следующий шаг записи. Дальше
 * разговор ведёт агент как обычно. Сотрудник ответил сам — не вмешиваемся:
 * разговор у человека, и бот поверх него хуже любой ошибки.
 *
 *   npx tsx scripts/age-refusal-fix.ts                       — список таких диалогов за неделю
 *   npx tsx scripts/age-refusal-fix.ts --phone=+79886433053  — один диалог: состояние и текст поправки
 *   npx tsx scripts/age-refusal-fix.ts --phone=… --send      — отправить поправку
 *
 * Без --send ничего не меняется и никому не пишется.
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { normalizePhone } from "../lib/phone";
import { sendText } from "../lib/integrations/whatsapp/green-api";
import { ungroundedAgeLimit, ungroundedAgeRefusal } from "../lib/agent/age-limit";
import { noteForAdmin } from "../lib/agent/slot-hold";

const CORRECTION =
  "Поправка к прошлому сообщению: оно было неверным — детей мы принимаем с первого месяца жизни, " +
  "так что записать малыша можно. Подскажите, пожалуйста, на какую услугу хотите записать ребёнка — " +
  "назову цену и длительность, а время подберёт администратор.";

const WHEN = (d: Date) =>
  new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(d);

/** Номер на экран — только хвост: целиком это персональные данные (§7). */
const tail = (chatId: string) => `…${chatId.split("@")[0].slice(-4)}`;

/** Отказ по возрасту: с числом или без. Справку не передаём — любой такой отказ под подозрением. */
const isAgeRefusal = (body: string) => ungroundedAgeRefusal(body, "") !== null || ungroundedAgeLimit(body, "") !== null;

/** Значение `--name=…`; номер с пробелами («+7 988 643-30-53») оболочка режет на части — склеиваем. */
const arg = (name: string) => {
  const argv = process.argv.slice(2);
  const at = argv.findIndex((a) => a.startsWith(`--${name}=`));
  if (at < 0) return null;
  const rest = argv.slice(at + 1);
  const end = rest.findIndex((a) => a.startsWith("--"));
  return [argv[at].slice(name.length + 3), ...(end < 0 ? rest : rest.slice(0, end))].join(" ").trim() || null;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

async function lastMessages(conversationId: string) {
  return prisma.message.findMany({
    where: { conversationId, deletedAt: null, isDraft: false },
    orderBy: { createdAt: "desc" },
    take: 6,
    select: { id: true, direction: true, authorType: true, body: true, createdAt: true },
  });
}

async function main() {
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const phone = arg("phone");

  if (!phone) {
    const since = new Date(Date.now() - 7 * 86_400_000);
    const dialogs = await prisma.conversation.findMany({
      where: { companyId: company.id, channel: "WHATSAPP", isPractice: false, lastMessageAt: { gte: since } },
      orderBy: { lastMessageAt: "desc" },
      take: 500,
      select: { id: true, externalUserId: true, contactName: true, patient: { select: { name: true } } },
    });
    let found = 0;
    for (const d of dialogs) {
      const [last] = await lastMessages(d.id);
      if (!last || last.direction !== "OUT" || last.authorType !== "BOT" || !isAgeRefusal(last.body)) continue;
      found += 1;
      const who = d.patient?.name?.trim() || d.contactName?.trim() || "без имени";
      console.log(`  ${WHEN(last.createdAt)} · ${who} · ${tail(d.externalUserId)} — после отказа никто не писал`);
    }
    console.log(found === 0 ? "За неделю таких диалогов нет." : `\nВсего: ${found}. Поправка — с --phone=… --send по каждому.`);
    return;
  }

  const e164 = normalizePhone(phone);
  if (!e164) throw new Error(`Не разобрать номер: ${phone}`);
  const digits = e164.replace(/\D/g, "");
  const conv = await prisma.conversation.findFirst({
    where: {
      companyId: company.id,
      channel: "WHATSAPP",
      OR: [{ externalUserId: `${digits}@c.us` }, { patient: { phones: { some: { phone: e164 } } } }],
    },
    orderBy: { lastMessageAt: "desc" },
    select: {
      id: true,
      externalUserId: true,
      status: true,
      agentDisabled: true,
      isPractice: true,
      contactName: true,
      patient: { select: { name: true } },
    },
  });
  if (!conv) {
    console.log("Переписки WhatsApp с этим номером нет.");
    return;
  }

  const who = conv.patient?.name?.trim() || conv.contactName?.trim() || "без имени";
  console.log(`Диалог: ${who} · ${tail(conv.externalUserId)} · статус ${conv.status}`);
  const recent = await lastMessages(conv.id);
  for (const m of [...recent].reverse()) {
    const author = m.direction === "IN" ? "пациент" : m.authorType === "BOT" ? "агент" : "сотрудник";
    // Тела сообщений на экран не выводим (§7): только кто и когда.
    console.log(`  ${WHEN(m.createdAt)} · ${author}${m.authorType === "BOT" && isAgeRefusal(m.body) ? " — ОТКАЗ ПО ВОЗРАСТУ" : ""}`);
  }

  const last = recent[0];
  const reasons: string[] = [];
  if (conv.isPractice) reasons.push("это тренировочная переписка");
  if (conv.agentDisabled) reasons.push("агент выключен в этом диалоге");
  if (!last || last.direction !== "OUT" || last.authorType !== "BOT") {
    reasons.push("после ответа агента уже писали — пациент или сотрудник; разговор у людей");
  } else if (!isAgeRefusal(last.body)) {
    reasons.push("последний ответ агента — не отказ по возрасту (поправка, возможно, уже ушла)");
  }
  if (reasons.length > 0) {
    console.log(`\nПоправку НЕ отправляем: ${reasons.join("; ")}.`);
    return;
  }

  console.log(`\nУйдёт пациенту:\n  «${CORRECTION}»`);
  if (!flag("send")) {
    console.log("\nЭто проверка. Отправить — тот же запуск с --send.");
    return;
  }

  // Сохраняем до отправки, как и ответ агента: эхо провайдера узнаётся по идентификатору.
  const row = await prisma.message.create({
    data: {
      companyId: company.id,
      conversationId: conv.id,
      channel: "WHATSAPP",
      direction: "OUT",
      authorType: "BOT",
      body: CORRECTION,
      status: "QUEUED",
    },
    select: { id: true },
  });
  const sent = await sendText(company.id, conv.externalUserId, CORRECTION);
  await prisma.message.update({
    where: { id: row.id },
    data: sent.ok
      ? { status: "SENT", sentAt: new Date(), externalId: sent.externalId ?? null }
      : { status: "FAILED", failureReason: sent.error?.slice(0, 300) ?? null },
  });
  await prisma.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: new Date() } });
  if (!sent.ok) {
    console.log(`\nНе отправлено: ${sent.error ?? "провайдер не принял"}. В переписке сообщение помечено «не доставлено».`);
    return;
  }
  await noteForAdmin(
    company.id,
    conv.id,
    "Агент ошибочно отказал по возрасту: клиника принимает детей с первого месяца. Пациенту отправлена поправка " +
      "и вопрос об услуге — дальше запись ведёт агент. Ошибка в коде исправлена.",
  );
  console.log("\nОтправлено. В диалоге оставлена заметка для администратора.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
