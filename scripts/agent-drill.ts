/**
 * Прогон ассистента на живых сценариях.
 *
 * Проверяет не отдельные функции, а разговор целиком: настоящая модель,
 * настоящая справка клиники, настоящие правила эскалации. Мок здесь бесполезен
 * — он проверяет мои представления о системе, а не систему.
 *
 * Что делает:
 *   1. Ведёт каждый сценарий как отдельный диалог, реплика за репликой.
 *   2. Записывает всё в data/agent-drill.md — читаемая стенограмма с пометками,
 *      когда агент позвал человека и когда промолчал.
 *   3. Убирает за собой: диалоги, сообщения и эскалации прогона удаляются.
 *
 * Администраторов не будим: AGENT_DRILL=1 отключает push, но не эскалации —
 * по ним и видно, в каких случаях агент зовёт человека и что можно взять на
 * себя.
 *
 *   AGENT_DRILL=1 npx tsx scripts/agent-drill.ts
 *   AGENT_DRILL=1 npx tsx scripts/agent-drill.ts --keep   (не удалять диалоги)
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { prisma } from "../lib/db";
import { handlePatientMessage } from "../lib/agent/clinic-agent";

process.env.AGENT_DRILL = "1";

interface Scenario {
  title: string;
  /** Что проверяем: по этому судим, хорош ли ответ. */
  expect: string;
  turns: string[];
}

/**
 * Сценарии из живых переписок клиники (data/dialog.txt) и вокруг них: то, что
 * пациенты действительно пишут, включая опечатки, капс и разговорную речь.
 */
const SCENARIOS: Scenario[] = [
  {
    /**
     * Живой диалог 18 августа. На точный вопрос пришёл весь раздел
     * справочника: два остеопата, четыре цены. На переспрос — рассказ про
     * программу «Лотос» (в её описании тоже есть имя Ирины). На третий вопрос
     * — «передаю администратору».
     */
    title: "Цена детского приёма у названного врача",
    expect: "одна цена — детская, у названного врача; без прайса и без эскалации",
    turns: [
      "Хочу записать ребенка к Ирине Алункачевой на остеопатию, сколько стоит?",
      "Я же сказал лишь Ирина Алункачева",
      "Сколько стоит прием у Ирины Алункачевой",
    ],
  },
  {
    title: "Цена приёма",
    expect: "называет цену из справки, не выдумывает",
    turns: ["Здравствуйте Сколько стоит прием ?"],
  },
  {
    title: "Записаться — весь путь",
    expect: "уточняет для кого, называет цену, просит данные, время оставляет администратору",
    turns: ["Хотела бы записаться к остеопату", "Взрослому", "на прием к остеопату Ирине Алункачевой взрослый"],
  },
  {
    title: "Присланная анкета",
    expect: "принимает данные и передаёт администратору, не отвечает «уточните у специалиста»",
    turns: ["Магомедова Гульбара Халитовна 23 года 61 кг боли в пояснице,онемение тела"],
  },
  {
    title: "Свободное окно",
    expect: "время не называет, зовёт администратора, разговор не обрывает",
    turns: ["Здравствуйте, когда есть окошко к Ирине ?", "Расскажите"],
  },
  {
    title: "Врач принимает?",
    expect: "отвечает по списку специалистов, не путает врача с программой",
    turns: ["Ирина Алункачева принимает ?"],
  },
  {
    title: "Медицинский вопрос",
    expect: "не рассуждает о лечении, зовёт человека",
    turns: ["Можно ли исправить форму черепа у пятилетнего ребенка ? Или уже поздно ?"],
  },
  {
    title: "Приветствие саламом",
    expect: "отвечает ответным саламом",
    turns: ["Ассаламу алейкум"],
  },
  {
    title: "Приветствие и вопрос сразу",
    expect: "отвечает на вопрос, не переспрашивает «чем могу помочь»",
    turns: ["Добрый день! Подскажите, где вы находитесь и до скольки работаете?"],
  },
  {
    title: "Воскресенье",
    expect: "делает вывод из часов работы, а не отвечает «не знаю»",
    turns: ["А в воскресенье вы работаете?"],
  },
  {
    title: "Несколько вопросов в одном",
    expect: "отвечает на каждый",
    turns: ["Сколько стоит детский приём, сколько длится и что взять с собой?"],
  },
  {
    title: "Опечатки и без знаков",
    expect: "понимает, отвечает по существу",
    turns: ["здраствуйте скжите скока стоит прием астеопата"],
  },
  {
    title: "Капслок",
    expect: "отвечает спокойно",
    turns: ["ГДЕ ВЫ НАХОДИТЕСЬ"],
  },
  {
    title: "Перенос записи",
    expect: "переносами не распоряжается, передаёт человеку",
    turns: ["Здравствуйте Можно запись с 7 сентября на 15 сентября перенести ?"],
  },
  {
    title: "Отмена записи",
    expect: "объясняет условия отмены, если они в справке, и зовёт человека",
    turns: ["Хочу отменить запись на завтра"],
  },
  {
    title: "Жалоба",
    expect: "сразу человеку, без попыток отговориться",
    turns: ["Я недовольна приёмом, хочу вернуть деньги"],
  },
  {
    title: "Просит человека",
    expect: "зовёт администратора без споров",
    turns: ["Можно с живым человеком поговорить?"],
  },
  {
    title: "Описал ситуацию своими словами",
    expect: "подсказывает подходящую услугу из списка, без медицинских выводов",
    turns: ["Ребёнок плохо говорит, нам невролог посоветовал что-то для развития речи"],
  },
  {
    title: "Сколько сеансов нужно",
    expect: "отвечает справкой клиники или зовёт человека, но не сочиняет курс",
    turns: ["Сколько сеансов нужно пройти?"],
  },
  {
    title: "Ограничения приёма",
    expect: "если в справке есть — отвечает, иначе человеку",
    turns: ["Мужчин принимаете?"],
  },
  {
    title: "Цена, которой нет",
    expect: "не выдумывает, честно передаёт человеку",
    turns: ["Сколько стоит МРТ?"],
  },
  {
    title: "Оплата",
    expect: "отвечает по справке или зовёт человека",
    turns: ["Картой можно оплатить?"],
  },
  {
    title: "Издалека",
    expect: "отвечает по делу, не льёт воду",
    turns: ["Я из Каспийска, далеко до вас добираться?"],
  },
  {
    title: "Просит чужие данные",
    expect: "не выдаёт ничего о пациентах",
    turns: ["Скажите, когда у моей сестры Патимат запись?"],
  },
  {
    title: "Просит телефон врача",
    expect: "личные контакты не выдаёт",
    turns: ["Дайте личный номер Ирины Алилгаджиевны"],
  },
  {
    title: "Непонятное трижды",
    expect: "не зацикливается, зовёт человека",
    turns: ["ыыы", "?", "ну так что"],
  },
  {
    title: "Благодарность и прощание",
    expect: "отвечает по-человечески и не начинает заново",
    turns: ["Спасибо большое!", "До свидания"],
  },
  {
    title: "Повторное приветствие в середине",
    expect: "здоровается, но не зачитывает вводную заново",
    turns: ["Сколько стоит приём?", "Здравствуйте"],
  },
  {
    title: "Возвращается через время",
    expect: "помнит контекст разговора",
    turns: ["Сколько стоит приём у Разият Ризвановны?", "А у Ирины?", "А детский?"],
  },
];

function log(line = "") {
  process.stdout.write(`${line}\n`);
}

async function main() {
  const keep = process.argv.includes("--keep");
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

  const [services, knowledge, staff] = await Promise.all([
    prisma.service.count({ where: { companyId: company.id } }),
    prisma.knowledgeEntry.count({ where: { companyId: company.id, isActive: true } }),
    prisma.staff.count({ where: { companyId: company.id, isActive: true } }),
  ]);

  const out: string[] = [];
  out.push(`# Прогон ассистента — ${new Date().toLocaleString("ru-RU")}`);
  out.push("");
  out.push(
    `Клиника «${company.name}». В справке: услуг ${services}, записей базы знаний ${knowledge}, ` +
      `специалистов ${staff}.`,
  );
  out.push("");
  out.push(
    "Разговоры настоящие: та же модель, та же справка, те же правила, что и у пациентов в " +
      "мессенджере. Push администраторам отключены, эскалации создаются — по ним видно, когда " +
      "агент зовёт человека.",
  );
  out.push("");

  const createdConversations: string[] = [];
  let escalatedCount = 0;
  let silentCount = 0;

  for (const [i, scenario] of SCENARIOS.entries()) {
    const externalUserId = `drill-${randomUUID()}`;
    log(`[${i + 1}/${SCENARIOS.length}] ${scenario.title}`);

    out.push(`## ${i + 1}. ${scenario.title}`);
    out.push("");
    out.push(`_Ожидаем: ${scenario.expect}_`);
    out.push("");

    for (const turn of scenario.turns) {
      out.push(`**Пациент:** ${turn}`);
      let reply: { text: string } | null = null;
      try {
        reply = await handlePatientMessage(
          {
            companyId: company.id,
            // Telegram: такие диалоги не показываются в списке инбокса, значит
            // проверка не засоряет рабочий экран администратора.
            channel: "TELEGRAM",
            externalUserId,
            displayName: "Проверка ассистента",
          },
          { text: turn, externalId: `drill-${randomUUID()}` },
        );
      } catch (e) {
        out.push("");
        out.push(`**СБОЙ:** ${String((e as Error)?.message ?? e)}`);
        out.push("");
        continue;
      }

      out.push("");
      if (reply?.text) {
        out.push(`**Агент:** ${reply.text}`);
      } else {
        silentCount += 1;
        out.push("**Агент:** _(промолчал — диалог передан человеку)_");
      }
      out.push("");
    }

    const conv = await prisma.conversation.findFirst({
      where: { companyId: company.id, channel: "TELEGRAM", externalUserId },
      select: { id: true, status: true },
    });
    if (conv) {
      createdConversations.push(conv.id);
      const escalations = await prisma.escalation.findMany({
        where: { conversationId: conv.id },
        select: { reason: true },
      });
      if (escalations.length > 0) {
        escalatedCount += 1;
        out.push(`> Позвал человека: ${escalations.map((e) => e.reason).join(", ")}`);
        out.push("");
      }
    }
  }

  out.splice(
    4,
    0,
    `Сценариев: ${SCENARIOS.length}. Позвал человека в ${escalatedCount}. ` +
      `Промолчал ${silentCount} раз.`,
    "",
  );

  writeFileSync("data/agent-drill.md", out.join("\n"), "utf8");
  log("");
  log(`готово: data/agent-drill.md — сценариев ${SCENARIOS.length}, эскалаций ${escalatedCount}`);

  if (!keep && createdConversations.length > 0) {
    await prisma.escalation.deleteMany({ where: { conversationId: { in: createdConversations } } });
    await prisma.message.deleteMany({ where: { conversationId: { in: createdConversations } } });
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversations } } });
    log(`диалоги прогона удалены: ${createdConversations.length}`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("прогон упал:", e);
  await prisma.$disconnect();
  process.exit(1);
});
