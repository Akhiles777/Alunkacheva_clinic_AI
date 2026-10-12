import { prisma } from "../lib/db";
import { makeWeeklyDigest } from "../lib/server/weekly-digest";
import { runQualityCheck } from "../lib/server/agent-quality";
import { FEATURES } from "../lib/metrics/adoption";
import { DEMO_YCLIENTS_ID } from "./demo-id";

/**
 * Последний слой демо-стенда — то, что появляется от работы людей с платформой:
 * заметки к диалогам, передача коллеге, отложенная отправка, уведомления,
 * отметки звонков из очереди, счётчики пользования, недельные сводки
 * владельцу и проверка качества ответов агента.
 *
 * Сводку и проверку качества делает тот же код, что и на сервере ночью
 * (с моделью, если задан ROUTER_AI, — это несколько запросов).
 *
 *   DATABASE_URL=…/clinic_demo AGENT_DRILL=1 npx tsx --env-file=.env scripts/demo-extras.ts --apply
 */

process.env.AGENT_DRILL = "1";
const DAY = 24 * 3600_000;
const MIN = 60_000;

let seed = 31337;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const between = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

async function main() {
  if (!process.argv.includes("--apply")) {
    console.log("Сухой прогон. --apply добавит заметки, задачи, уведомления, сводки и проверку качества.");
    return;
  }
  const company = await prisma.company.findFirstOrThrow({ where: { yclientsId: DEMO_YCLIENTS_ID } });
  const companyId = company.id;
  const now = Date.now();
  const users = Object.fromEntries((await prisma.staffUser.findMany({ where: { companyId }, select: { login: true, id: true } })).map((u) => [u.login, u.id]));
  const admin = users.admin;
  const admin2 = users.admin2 ?? users.admin;
  const recipients = [users.admin, users.admin2, users.demo, users.owner].filter(Boolean) as string[];

  // Повторный запуск — с чистого листа для всего, что заводит этот скрипт.
  await prisma.dialogNote.deleteMany({ where: { companyId } });
  await prisma.dialogTask.deleteMany({ where: { companyId } });
  await prisma.dialogHandoff.deleteMany({ where: { companyId } });
  await prisma.notification.deleteMany({ where: { companyId } });
  await prisma.featureUse.deleteMany({ where: { companyId } });
  await prisma.callbackOutreach.deleteMany({ where: { companyId } });
  await prisma.weeklyDigest.deleteMany({ where: { companyId } });

  /** Переписка по первой реплике пациента — так сценарии узнаются без своих меток. */
  async function convBy(firstText: string) {
    const m = await prisma.message.findFirst({
      where: { companyId, direction: "IN", body: { startsWith: firstText } },
      orderBy: { createdAt: "desc" },
      select: { conversationId: true, createdAt: true, conversation: { select: { contactName: true, patient: { select: { name: true } } } } },
    });
    return m;
  }

  // ── заметки и передачи
  const notes: [string, string, string][] = [
    ["Добрый вечер. У дочки 7 лет сколиоз", "Мама просила перезвонить после 10 утра. Предложить осмотр у Ирины Алилгаджиевны — со снимками.", admin],
    ["Здравствуйте, мы пропустили две недели БОС", "Курс прерван из-за болезни. Уточнила у Ирины Омаровой — можно продолжать, сеансы сохраняются.", admin2],
    ["Здравствуйте. У сына ДЦП, 5 лет", "Предупредила Ирину Омарову. Мама принесёт выписки невролога.", admin],
    ["Добрый день. Вчера ждали приёма почти 40 минут", "Повторный приём ребёнка — без доплаты, согласовано с Ириной Алилгаджиевной.", admin2],
  ];
  for (const [text, body, author] of notes) {
    const c = await convBy(text);
    if (c) await prisma.dialogNote.create({ data: { companyId, conversationId: c.conversationId, authorId: author, body, createdAt: new Date(c.createdAt.getTime() + between(5, 60) * MIN) } });
  }
  const complaint = await convBy("Добрый день. Вчера ждали приёма почти 40 минут");
  if (complaint && admin && admin2) {
    await prisma.dialogHandoff.create({
      data: { companyId, conversationId: complaint.conversationId, fromId: admin, toId: admin2, comment: "Жалоба на ожидание — ответь, пожалуйста, ты вчера была на смене.", createdAt: new Date(complaint.createdAt.getTime() + 8 * MIN), acceptedAt: new Date(complaint.createdAt.getTime() + 20 * MIN) },
    });
  }

  // ── отложенная отправка: «ответим в девять утра»
  const evening = await convBy("Здравствуйте! Сколько стоит приём остеопата для ребёнка 3 лет?");
  if (evening && admin) {
    const local = new Date(now + 3 * 3600_000);
    const tomorrow9 = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, 9 - 3, 0);
    await prisma.dialogTask.create({
      data: {
        companyId,
        conversationId: evening.conversationId,
        kind: "SEND",
        body: "Мадина, доброе утро! На этой неделе есть окошко к Ирине Алилгаджиевне в среду в 9:30 и к Разият Ризвановне в четверг в 14:00. Какое время вам удобнее?",
        runAt: new Date(tomorrow9),
        createdById: admin,
        createdAt: new Date(now - 20 * MIN),
      },
    });
  }

  // ── уведомления: то, что сейчас ждёт людей
  const waiting = await prisma.conversation.findMany({
    where: { companyId, OR: [{ status: "ESCALATED" }, { unreadCount: { gt: 0 } }], lastMessageAt: { gt: new Date(now - 2 * DAY) } },
    select: { id: true, contactName: true, lastMessageAt: true, patient: { select: { name: true } }, status: true },
  });
  for (const c of waiting) {
    const who = c.patient?.name ?? c.contactName ?? "Пациент";
    await prisma.notification.createMany({
      data: recipients.map((staffUserId) => ({
        companyId,
        staffUserId,
        kind: c.status === "ESCALATED" ? ("ESCALATION" as const) : ("PATIENT_MESSAGE" as const),
        title: c.status === "ESCALATED" ? "Диалог передан человеку" : `Новое сообщение — ${who}`,
        body: c.status === "ESCALATED" ? `${who}: нужен ответ администратора` : "Пациент ждёт ответа",
        url: "/inbox",
        entityId: c.id,
        createdAt: c.lastMessageAt,
      })),
    });
  }

  // ── очередь «Кому позвонить»: часть уже обзвонили
  const stalled = await prisma.course.findMany({ where: { companyId, status: "ACTIVE" }, take: 12, select: { patientId: true, sessionsTotal: true, sessionsUsed: true, pricePerSession: true } });
  for (const [i, c] of stalled.entries()) {
    if (i % 2) continue;
    await prisma.callbackOutreach.create({
      data: {
        companyId,
        patientId: c.patientId,
        kind: "COURSE_STALLED",
        basis: `Осталось ${c.sessionsTotal - c.sessionsUsed} из ${c.sessionsTotal} сеансов`,
        money: Number(c.pricePerSession) * (c.sessionsTotal - c.sessionsUsed),
        staffUserId: admin ?? null,
        createdAt: new Date(now - between(1, 20) * DAY),
      },
    });
  }

  // ── чем пользуются: числа по дням за месяц
  const weight: Record<string, [number, number]> = {
    "dialog-open": [25, 60], template: [3, 12], hotkey: [5, 30], note: [0, 4], handoff: [0, 2], later: [0, 2],
    attachment: [0, 3], voice: [0, 1], bulk: [0, 1], assistant: [1, 6], broadcast: [0, 1],
  };
  for (let d = 30; d >= 0; d--) {
    const day = new Date(Math.floor((now - d * DAY) / DAY) * DAY);
    if (day.getUTCDay() === 0) continue;
    for (const f of FEATURES) {
      const [a, b] = weight[f.key] ?? [0, 2];
      const count = between(a, b);
      if (count > 0) await prisma.featureUse.create({ data: { companyId, day, feature: f.key, count } });
    }
  }

  // ── недельные сводки владельцу: тот же расчёт, что в понедельник утром
  for (let w = 4; w >= 0; w--) {
    const at = new Date(now - w * 7 * DAY);
    const r = await makeWeeklyDigest(companyId, at).catch((e) => ({ error: (e as Error).message }));
    console.log(`сводка −${w} нед.:`, "error" in r ? r.error : r.created ? "создана" : "уже была");
  }

  // ── проверка качества ответов агента — одна порция, как ночью
  const q = await runQualityCheck(companyId).catch((e) => ({ error: (e as Error).message }));
  console.log("проверка качества:", JSON.stringify(q));

  console.log("готово");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
