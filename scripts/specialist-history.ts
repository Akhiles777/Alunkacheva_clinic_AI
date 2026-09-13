/**
 * Подгрузить в платформу прошлую переписку со специалистом из Green API.
 *
 * Вопросы врачу и её ответы до сих пор жили только в кабинете Green API:
 * заказчик нашёл их там и сначала решил, что вопросы не отправлялись вовсе.
 * Журнал `SpecialistMessage` показывает переписку в диалоге пациента, но
 * заводится с момента выкатки — прошлое нужно подгрузить отдельно.
 *
 * ЧТО СКРИПТ НЕ ДЕЛАЕТ НИКОГДА:
 *   · не отправляет ни одного сообщения — ни врачу, ни пациенту;
 *   · не пересылает ответ врача пациенту и не меняет состояние вопросов:
 *     ответ, который агент в своё время не смог привязать, остаётся
 *     непереданным — решает человек, пересылать ли его теперь.
 * Он только ЧИТАЕТ историю чата у провайдера и складывает её в журнал.
 *
 * Привязка к вопросу — тем же правилом, что у агента (`linkToQuery`): по метке
 * «#N», а без неё — только если открытый вопрос был ровно один. Иначе
 * сообщение ложится без привязки и подписывается «к какому вопросу — неясно».
 *
 * Повторный запуск ничего не задваивает: у каждого сообщения провайдера свой
 * идентификатор.
 *
 *   npx tsx scripts/specialist-history.ts           # показать, что будет подгружено
 *   npx tsx scripts/specialist-history.ts --apply   # подгрузить
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { chatIdFromPhone } from "../lib/integrations/whatsapp/chat-id";
import { fetchChatHistory } from "../lib/integrations/whatsapp/green-api";
import { linkToQuery } from "../lib/agent/specialist-rules";

const WHEN = (d: Date) =>
  new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(d);

/** Сколько последних сообщений чата берём. Переписка с врачом короткая. */
const HISTORY_COUNT = 200;

async function main() {
  const apply = process.argv.includes("--apply");
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  console.log(`клиника: ${company.name}`);
  console.log(apply ? "режим: ПОДГРУЗКА (только чтение из Green API, отправок нет)\n" : "режим: сухой прогон — ничего не записывается\n");

  const specialists = await prisma.clinicSpecialist.findMany({
    where: { companyId: company.id },
    select: { id: true, name: true, phone: true },
  });

  let added = 0;
  for (const sp of specialists) {
    const chatId = chatIdFromPhone(sp.phone);
    if (!chatId) {
      console.log(`── ${sp.name}: номер не разобран, пропускаю`);
      continue;
    }

    const [history, queries] = await Promise.all([
      fetchChatHistory(company.id, chatId, HISTORY_COUNT),
      prisma.specialistQuery.findMany({
        where: { companyId: company.id, specialistId: sp.id },
        select: { id: true, ref: true, askedAt: true, answeredAt: true, conversationId: true },
      }),
    ]);

    /**
     * Берём переписку не раньше первого вопроса: всё, что было в чате с
     * врачом до подключения агента, — её личная переписка с клиникой, и в
     * диалогах пациентов ей не место.
     */
    const firstAsked = queries.reduce<Date | null>(
      (min, q) => (min === null || q.askedAt < min ? q.askedAt : min),
      null,
    );
    const relevant = firstAsked
      ? history.filter((m) => m.at.getTime() >= firstAsked.getTime() - 60_000)
      : [];

    console.log(`── ${sp.name} (${chatId})`);
    console.log(`   в истории у провайдера: ${history.length}, после первого вопроса: ${relevant.length}, вопросов: ${queries.length}`);
    if (queries.length === 0) {
      console.log("   вопросов не было — подгружать нечего\n");
      continue;
    }

    for (const m of relevant) {
      const known = await prisma.specialistMessage.findUnique({
        where: { companyId_externalId: { companyId: company.id, externalId: m.externalId } },
        select: { id: true },
      });
      const queryId = linkToQuery({ body: m.text, quoted: m.quoted ?? null, at: m.at }, queries);
      const ref = queries.find((q) => q.id === queryId)?.ref;
      const who = m.direction === "OUT" ? "платформа → врачу" : "врач";
      console.log(
        `   ${known ? "уже есть" : apply ? "подгружено" : "будет"}  ${WHEN(m.at)}  ${who.padEnd(17)} ` +
          `${ref ? `#${ref}` : "без привязки"}  «${m.text.replace(/\s+/g, " ").slice(0, 60)}»`,
      );
      if (known || !apply) continue;

      /**
       * Письмо, записанное на ходу без идентификатора (так было до выкатки
       * журнала), дополняем идентификатором, а не заводим вторую строку.
       */
      const twin = await prisma.specialistMessage.findFirst({
        where: {
          companyId: company.id,
          specialistId: sp.id,
          externalId: null,
          direction: m.direction,
          body: m.text,
        },
        select: { id: true },
      });
      if (twin) {
        await prisma.specialistMessage.update({ where: { id: twin.id }, data: { externalId: m.externalId } });
        continue;
      }
      await prisma.specialistMessage.create({
        data: {
          companyId: company.id,
          specialistId: sp.id,
          queryId,
          direction: m.direction,
          body: m.text,
          quoted: m.quoted ?? null,
          externalId: m.externalId,
          sentAt: m.at,
        },
      });
      added += 1;
    }
    console.log("");
  }

  console.log(apply ? `Подгружено сообщений: ${added}. Отправок не было ни одной.` : "Сухой прогон. Чтобы подгрузить: --apply");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
