/**
 * Тренировочные переписки: потренироваться, ничего не отправив пациенту.
 *
 * Администратор учится теми же кнопками, которыми работает, — иначе учёба не
 * стоит ничего. Значит и обрыв должен стоять не в интерфейсе, а в отправке:
 * у такой переписки `Conversation.isPractice`, и `sendMessageDb` до провайдера
 * не доходит. В метрики они тоже не идут: учебные сообщения в воронке
 * означали бы, что клиника считает своей работой тренировку.
 *
 *   npx tsx scripts/practice-dialogs.ts            # только показать
 *   npx tsx scripts/practice-dialogs.ts --apply    # завести
 *   npx tsx scripts/practice-dialogs.ts --remove --apply   # убрать
 *
 * Сухой прогон по умолчанию. Настоящие переписки скрипт не трогает ни в каком
 * режиме: он работает только со своими, помеченными `isPractice`.
 */
import "dotenv/config";
import { prisma } from "../lib/db";

/** Адрес учебного собеседника узнаётся по этой приставке. */
const PREFIX = "practice-";

interface Line {
  from: "patient" | "staff";
  text: string;
  /** За сколько минут до «сейчас» пришло сообщение. */
  minutesAgo: number;
}

interface Scenario {
  key: string;
  name: string;
  /** Что отрабатываем — видно в заметке к диалогу. */
  drill: string;
  lines: Line[];
}

/**
 * Четыре случая, на которых ломается новичок: первый вопрос о цене, ребёнок,
 * перенос и жалоба после приёма. Тексты живые — списаны с настоящих обращений
 * по смыслу, без чьих-либо данных.
 */
const SCENARIOS: Scenario[] = [
  {
    key: "price",
    name: "Тренировка · спрашивают цену",
    drill: "Ответить на вопрос о цене и предложить записаться. Попробуйте шаблон по «/».",
    lines: [
      { from: "patient", text: "Здравствуйте! Сколько стоит приём остеопата?", minutesAgo: 42 },
      { from: "patient", text: "И есть ли места на этой неделе?", minutesAgo: 41 },
    ],
  },
  {
    key: "child",
    name: "Тренировка · записывают ребёнка",
    drill: "Собрать данные: ФИО ребёнка, возраст, имя родителя и причину. Один вопрос за раз.",
    lines: [
      { from: "patient", text: "Добрый день, хочу записать ребёнка", minutesAgo: 18 },
      { from: "staff", text: "Здравствуйте! Подскажите, сколько лет ребёнку и что беспокоит?", minutesAgo: 16 },
      { from: "patient", text: "6 лет, две недели назад поставили аппарат, направили к вам", minutesAgo: 3 },
    ],
  },
  {
    key: "move",
    name: "Тренировка · просят перенести",
    drill: "Перенос ведёт администратор. Уточните, на когда удобно, и отметьте это заметкой.",
    lines: [
      { from: "patient", text: "Я записана на четверг в 11:30", minutesAgo: 130 },
      { from: "patient", text: "Можно перенести? В четверг никак не получится", minutesAgo: 129 },
    ],
  },
  {
    key: "after",
    name: "Тренировка · жалоба после приёма",
    drill: "Сложный вопрос о здоровье — не отвечайте сами: передайте коллеге или позовите админа.",
    lines: [
      { from: "patient", text: "Здравствуйте. После вчерашнего приёма побаливает шея, это нормально?", minutesAgo: 8 },
    ],
  },
];

async function main() {
  const apply = process.argv.includes("--apply");
  const remove = process.argv.includes("--remove");

  const company = await prisma.company.findFirstOrThrow({
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
  console.log(`клиника: ${company.name}`);

  const existing = await prisma.conversation.findMany({
    where: { companyId: company.id, isPractice: true },
    select: { id: true, contactName: true },
  });
  console.log(`тренировочных переписок сейчас: ${existing.length}`);

  if (remove) {
    console.log("\nБУДЕТ УБРАНО:");
    for (const c of existing) console.log(`  ${c.contactName ?? c.id}`);
    if (!apply) {
      console.log("\nсухой прогон: ничего не убрано");
      console.log("убрать: npx tsx scripts/practice-dialogs.ts --remove --apply");
      return;
    }
    const ids = existing.map((c) => c.id);
    if (ids.length > 0) {
      await prisma.dialogTask.deleteMany({ where: { conversationId: { in: ids } } });
      await prisma.dialogNote.deleteMany({ where: { conversationId: { in: ids } } });
      await prisma.dialogHandoff.deleteMany({ where: { conversationId: { in: ids } } });
      await prisma.message.deleteMany({ where: { conversationId: { in: ids } } });
      await prisma.conversation.deleteMany({ where: { id: { in: ids }, isPractice: true } });
    }
    console.log(`\nубрано: ${ids.length}`);
    return;
  }

  console.log("\nБУДЕТ ЗАВЕДЕНО:");
  for (const s of SCENARIOS) {
    const already = existing.some((c) => c.contactName === s.name);
    console.log(`  ${already ? "уже есть" : "новая  "}  ${s.name} — ${s.drill}`);
  }
  if (!apply) {
    console.log("\nсухой прогон: ничего не записано");
    console.log("завести: npx tsx scripts/practice-dialogs.ts --apply");
    return;
  }

  const now = Date.now();
  let made = 0;
  for (const scenario of SCENARIOS) {
    const externalUserId = `${PREFIX}${scenario.key}`;
    const last = scenario.lines[scenario.lines.length - 1];
    const conv = await prisma.conversation.upsert({
      where: {
        companyId_channel_externalUserId: {
          companyId: company.id,
          channel: "WHATSAPP",
          externalUserId,
        },
      },
      update: {
        isPractice: true,
        contactName: scenario.name,
        staffReadAt: null,
        lastMessageAt: new Date(now - last.minutesAgo * 60_000),
      },
      create: {
        companyId: company.id,
        channel: "WHATSAPP",
        externalUserId,
        contactName: scenario.name,
        isPractice: true,
        /**
         * Разговор ведёт человек, а не агент: тренировка — это упражнение для
         * сотрудника, и ассистент в неё не вмешивается ни при каких условиях.
         */
        status: "HUMAN_TAKEOVER",
        agentDisabled: true,
        startedAt: new Date(now - 3 * 3600_000),
        lastMessageAt: new Date(now - last.minutesAgo * 60_000),
      },
      select: { id: true },
    });

    // Переписку пересобираем заново: тренировка должна начинаться с начала.
    await prisma.message.deleteMany({ where: { conversationId: conv.id } });
    for (const [i, line] of scenario.lines.entries()) {
      const at = new Date(now - line.minutesAgo * 60_000);
      await prisma.message.create({
        data: {
          companyId: company.id,
          conversationId: conv.id,
          channel: "WHATSAPP",
          direction: line.from === "patient" ? "IN" : "OUT",
          authorType: line.from === "patient" ? "PATIENT" : "STAFF",
          body: line.text,
          externalId: `${PREFIX}${scenario.key}-${i}`,
          status: "SENT",
          sentAt: line.from === "staff" ? at : null,
          createdAt: at,
        },
      });
    }
    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        lastPatientMessageAt: new Date(
          now -
            (scenario.lines.filter((l) => l.from === "patient").slice(-1)[0]?.minutesAgo ??
              last.minutesAgo) *
              60_000,
        ),
      },
    });

    // Задание к упражнению — заметкой: она видна всем и пациенту не уходит.
    await prisma.dialogNote.deleteMany({ where: { conversationId: conv.id } });
    await prisma.dialogNote.create({
      data: {
        companyId: company.id,
        conversationId: conv.id,
        body: `Упражнение: ${scenario.drill}`,
      },
    });
    made += 1;
  }

  console.log(`\nзаведено: ${made}`);
  console.log("Они помечены «тренировка», наружу из них ничего не уходит и в метрики они не идут.");
  console.log("Убрать: npx tsx scripts/practice-dialogs.ts --remove --apply");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
