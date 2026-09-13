/**
 * Почему специалист не видит вопросов от ассистента.
 *
 * Жалоба: «вопросов 2, ответов 0, но в чатах я его не вижу». Счётчик не врёт —
 * строка `SpecialistQuery` заводится ТОЛЬКО после того, как провайдер принял
 * сообщение и вернул идентификатор. Значит отправка состоялась, и вопрос не в
 * ней.
 *
 * Дальше развилка, и различить её можно единственным способом — спросить у
 * провайдера, есть ли WhatsApp у этого номера. Green API принимает отправку на
 * ЛЮБОЙ номер и возвращает идентификатор: для нас это «ok», а доходит
 * сообщение только туда, где WhatsApp есть. Второй частый случай — номер
 * клиники совпадает с номером специалиста: тогда сообщение уходит самому себе
 * и лежит в чате «Вы», где его не ищут.
 *
 * Скрипт ничего не меняет — только читает и спрашивает провайдера.
 *
 *   npx tsx scripts/specialist-check.ts
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { chatIdFromPhone } from "../lib/integrations/whatsapp/chat-id";
import { numberHasWhatsapp, instanceState } from "../lib/integrations/whatsapp/green-api";

const WHEN = (d: Date) =>
  new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(d);

async function main() {
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  console.log(`клиника: ${company.name}\n`);

  const state = await instanceState(company.id).catch(() => null);
  console.log("── СОСТОЯНИЕ WHATSAPP");
  console.log(`  ${state ? `${state.state} — ${state.hint}` : "не удалось спросить провайдера"}`);
  console.log(
    "  Не «authorized» — не уходит ничего и никому, и разбирать остальное бессмысленно.\n",
  );

  const specialists = await prisma.clinicSpecialist.findMany({
    where: { companyId: company.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      phone: true,
      isActive: true,
      staff: { select: { name: true, specialty: true } },
    },
  });

  if (specialists.length === 0) {
    console.log("── КОМУ ПЕРЕСЫЛАТЬ");
    console.log("  Никого не заведено — вопросы идут администратору, как раньше.");
    return;
  }

  console.log("── КОМУ ПЕРЕСЫЛАТЬ");
  for (const s of specialists) {
    const chatId = chatIdFromPhone(s.phone);
    const check = chatId ? await numberHasWhatsapp(company.id, s.phone) : null;

    const verdict = !chatId
      ? "НОМЕР НЕ РАЗОБРАН — сообщение не уйдёт вовсе"
      : !check?.ok
        ? `проверить не удалось: ${check?.error ?? "нет ответа"}`
        : check.exists
          ? "WhatsApp есть"
          : "WhatsApp У НОМЕРА НЕТ — сюда и уходили вопросы, поэтому их никто не видел";

    console.log(`  ${s.name}${s.isActive ? "" : " · выключен"}`);
    console.log(`    номер: ${s.phone} → ${chatId ?? "—"}`);
    console.log(`    ${verdict}`);

    const [asked, answered, last] = await Promise.all([
      prisma.specialistQuery.count({ where: { companyId: company.id, specialistId: s.id } }),
      prisma.specialistQuery.count({
        where: { companyId: company.id, specialistId: s.id, status: "ANSWERED" },
      }),
      prisma.specialistQuery.findFirst({
        where: { companyId: company.id, specialistId: s.id },
        orderBy: { askedAt: "desc" },
        select: { ref: true, askedAt: true, status: true, question: true },
      }),
    ]);
    console.log(`    вопросов ${asked}, ответов ${answered}`);
    if (last) {
      console.log(
        `    последний: #${last.ref} от ${WHEN(last.askedAt)}, состояние ${last.status}`,
      );
      console.log(`      «${last.question.replace(/\s+/g, " ").slice(0, 90)}»`);
    }
    console.log("");
  }

  /**
   * Номер самой клиники. Если он совпадает с номером специалиста, вопросы
   * уходят в чат «Вы» — сообщение отправлено, доставлено и невидимо.
   */
  console.log("── ЧТО ПРОВЕРИТЬ ГЛАЗАМИ");
  console.log("  1. Совпадает ли номер специалиста с номером самой клиники в WhatsApp.");
  console.log("     Если да — вопросы лежат в чате с самим собой, там их и искать.");
  console.log("  2. Не заблокирован ли номер клиники у специалиста.");
  console.log("  3. Открыт ли у неё WhatsApp именно на этом номере, а не на другом.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
