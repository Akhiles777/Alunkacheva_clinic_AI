import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { prisma } from "../lib/db";
import { handlePatientMessage, type AgentChannel } from "../lib/agent/clinic-agent";
import { recomputeAppointmentSources, recomputePatientSources, recomputeVisitKinds } from "../lib/metrics/recompute";
import { DEMO_YCLIENTS_ID } from "./demo-id";

/**
 * Живые переписки демо-стенда: их ведёт НАСТОЯЩИЙ агент.
 *
 * Сочинять ответы агента руками нельзя: клиент увидит в инбоксе не то, что
 * агент говорит на самом деле, и спросит его потом о том же — с другим
 * ответом. Поэтому каждая реплика пациента идёт через `handlePatientMessage`
 * (справка, правила, согласие, эскалации, модель), а ответы сотрудников —
 * обычными сообщениями, как их пишет администратор из инбокса.
 *
 * Агент отвечает «сейчас», а переписка должна лежать в прошлом: после
 * разговора все его отметки (сообщения, эскалации, журнал попыток, согласие,
 * карточка) переносятся на заданные день и час с живыми паузами между
 * репликами — тем же приёмом, что «прошло N часов» в прогоне.
 *
 * AGENT_DRILL=1 — без push и без отправки наружу. Стоит денег: каждая реплика
 * без готового ответа в коде — запрос к модели (копейки на разговор).
 *
 *   DATABASE_URL=…/clinic_demo AGENT_DRILL=1 npx tsx scripts/demo-dialogs.ts --apply [--only=T1,R3]
 */

process.env.AGENT_DRILL = "1";

type StaffKey = "irina" | "raziyat" | "omarova" | "nuriyat" | "safiya";

type Turn =
  | string
  /** Ответ администратора из платформы; `phone` — набран на телефоне клиники. */
  | { staff: string; by?: "admin" | "admin2"; after?: number; phone?: boolean }
  /** Пауза перед следующей репликой пациента, минуты. */
  | { wait: number };

interface Booking {
  staff: StaffKey;
  service: string;
  /** День приёма относительно сегодняшнего. */
  day: number;
  minute: number;
}

interface Scenario {
  key: string;
  channel: AgentChannel;
  /** Новый человек — или постоянный пациент, подобранный по признаку. */
  who: "new" | "upcoming" | "stalledCourse" | "recentIv" | "recentChild";
  displayName: string;
  daysAgo: number;
  /** Час первой реплики по времени клиники. */
  hour: number;
  turns: Turn[];
  book?: Booking;
  /** Запись, на которую ссылается переписка, переносится/отменяется. */
  apptChange?: "cancel" | "move";
  note?: string;
}

const SCENARIOS: Scenario[] = [
  // ── сегодня
  {
    key: "T1",
    channel: "WHATSAPP",
    who: "new",
    displayName: "Мадина",
    daysAgo: 0,
    hour: 18.6,
    turns: ["Здравствуйте! Сколько стоит приём остеопата для ребёнка 3 лет?", { wait: 4 }, "А на этой неделе есть свободное окошко?"],
  },
  {
    key: "T2",
    channel: "INSTAGRAM",
    who: "new",
    displayName: "zarema_m",
    daysAgo: 0,
    hour: 19.05,
    turns: ["Добрый вечер. У дочки 7 лет сколиоз первой степени, врач направил к остеопату. Остеопатия поможет при сколиозе?"],
  },
  {
    key: "T3",
    channel: "WHATSAPP",
    who: "stalledCourse",
    displayName: "",
    daysAgo: 0,
    hour: 17.8,
    turns: ["Здравствуйте, мы пропустили две недели БОС из-за болезни. Можно продолжить курс? Сеансы ещё остались"],
  },
  {
    key: "T4",
    channel: "WHATSAPP",
    who: "new",
    displayName: "Луиза",
    daysAgo: 0,
    hour: 10.9,
    turns: [
      "Здравствуйте, хочу записать сына к остеопату",
      { wait: 3 },
      "Ему 4 года, к Ирине Алилгаджиевне",
      { wait: 2 },
      "Да",
      { wait: 4 },
      "Гаджиев Ислам, 4 года, мама Луиза. Плохо спит, жалуется что болят ноги после садика",
      { staff: "Луиза, здравствуйте! Записала Ислама к Ирине Алилгаджиевне на четверг, 15 октября, в 10:30. Ждём вас, возьмите с собой выписки, если есть 🙏", after: 22 },
      { wait: 6 },
      "Спасибо большое!",
    ],
    book: { staff: "irina", service: "Остеопатия - дети, прием Ирины", day: 3, minute: 10 * 60 + 30 },
  },
  {
    key: "T5",
    channel: "TELEGRAM",
    who: "new",
    displayName: "Камила",
    daysAgo: 0,
    hour: 13.15,
    turns: ["Подскажите адрес и до скольки вы работаете?", { wait: 2 }, "Спасибо"],
  },
  {
    key: "T6",
    channel: "WHATSAPP",
    who: "upcoming",
    displayName: "",
    daysAgo: 0,
    hour: 9.3,
    turns: ["Добрый день! Напомните, пожалуйста, когда у меня запись?"],
  },
  {
    key: "T7",
    channel: "WHATSAPP",
    who: "new",
    displayName: "Айшат",
    daysAgo: 0,
    hour: 15.5,
    turns: ["Здравствуйте. Сколько стоят капельницы? Хочется что-то от постоянной усталости", { wait: 3 }, "А анализы перед этим нужно сдавать?"],
  },
  {
    key: "T8",
    channel: "INSTAGRAM",
    who: "new",
    displayName: "dina.aliyeva",
    daysAgo: 0,
    hour: 16.3,
    turns: ["Что за программа Лотос и сколько стоит?"],
  },

  // ── последние недели
  {
    key: "R1",
    channel: "WHATSAPP",
    who: "new",
    displayName: "Сабина",
    daysAgo: 1,
    hour: 20.2,
    turns: [
      "Здравствуйте, можно записать ребёнка на БОС-терапию? Сыну 8 лет, плохая концентрация в школе",
      { staff: "Здравствуйте, Сабина! Начинаем с диагностики у Ирины Омаровой (1000 ₽, 30 минут) — она подскажет, нужен ли курс. Могу предложить среду, 14 октября, в 11:00. Удобно?", after: 13 * 60 },
      { wait: 9 },
      "Да, подходит",
      { staff: "Записала вас на среду, 14 октября, в 11:00. До встречи!", after: 4 },
    ],
    book: { staff: "omarova", service: "Диагностика/консультация на БОС-терапию", day: 2, minute: 11 * 60 },
  },
  {
    key: "R2",
    channel: "WHATSAPP",
    who: "upcoming",
    displayName: "",
    daysAgo: 2,
    hour: 12.4,
    turns: [
      "Здравствуйте! Можно перенести мою запись на другой день? В этот день не получится",
      { staff: "Здравствуйте! Конечно. Можем перенести на четверг в 11:00 — удобно?", after: 18 },
      { wait: 5 },
      "Да, отлично, спасибо",
      { staff: "Готово, перенесла. Ждём вас в четверг в 11:00 🌿", after: 3 },
    ],
  },
  {
    key: "R3",
    channel: "WHATSAPP",
    who: "new",
    displayName: "Заира",
    daysAgo: 3,
    hour: 11.2,
    turns: [
      "Здравствуйте, уже месяц болит поясница. Хотела записаться к остеопату",
      { wait: 3 },
      "Для себя, мне 41. Можно к Разият Ризвановне",
      { wait: 2 },
      "Согласна",
      { wait: 5 },
      "Курбанова Заира Ахмедовна, 41 год, вес 68. Болит поясница месяц, отдаёт в ногу",
      { staff: "Заира Ахмедовна, здравствуйте! Записала вас к Разият Ризвановне на сегодня, 12 октября, в 14:00. Если что-то изменится — напишите здесь.", after: 35 },
      { wait: 10 },
      "Хорошо, спасибо!",
    ],
    book: { staff: "raziyat", service: "Остеопатия, прием Разият", day: 0, minute: 14 * 60 },
  },
  {
    key: "R4",
    channel: "INSTAGRAM",
    who: "new",
    displayName: "patimat.gasanova",
    daysAgo: 4,
    hour: 17.1,
    turns: [
      "Добрый день. Вчера ждали приёма почти 40 минут, никто не предупредил о задержке. Хочу оставить жалобу",
      { staff: "Патимат, здравствуйте. Приносим извинения — вчера предыдущий приём затянулся, и мы должны были вас предупредить. Передала руководителю клиники; следующий приём для вашего ребёнка проведём без доплаты за повторный.", after: 26 },
      { wait: 12 },
      "Спасибо, что ответили",
    ],
  },
  {
    key: "R5",
    channel: "WHATSAPP",
    who: "recentIv",
    displayName: "",
    daysAgo: 5,
    hour: 14.6,
    turns: [
      "Здравствуйте, после капельницы немного кружится голова, это нормально?",
      { staff: "Здравствуйте! После инфузии такое бывает в первые часы — выпейте воды и отдохните. Если к вечеру не пройдёт или станет хуже — позвоните нам, медсестра перезвонит.", after: 9 },
      { wait: 40 },
      "Прошло, спасибо большое",
    ],
  },
  {
    key: "R6",
    channel: "WHATSAPP",
    who: "new",
    displayName: "Асият",
    daysAgo: 6,
    hour: 10.4,
    turns: [
      "Здравствуйте! Принимаете беременных? Срок 24 недели, тянет поясницу",
      { wait: 4 },
      "Хочу записаться",
    ],
  },
  {
    key: "R7",
    channel: "TELEGRAM",
    who: "new",
    displayName: "Руслан",
    daysAgo: 7,
    hour: 9.7,
    turns: [
      "Есть ли рядом с клиникой парковка?",
      { staff: "Здравствуйте! Да, во дворе дома есть бесплатная парковка, заезд с ул. Островского.", after: 14 },
      { wait: 3 },
      "Спасибо",
    ],
  },
  {
    key: "R8",
    channel: "WHATSAPP",
    who: "recentChild",
    displayName: "",
    daysAgo: 8,
    hour: 15.2,
    turns: ["Здравствуйте, а оплатить картой можно?"],
  },
  {
    key: "R9",
    channel: "WHATSAPP",
    who: "upcoming",
    displayName: "",
    daysAgo: 9,
    hour: 19.4,
    turns: [
      "Здравствуйте, завтра не сможем прийти — ребёнок заболел, температура. Отмените, пожалуйста, запись",
      { staff: "Здравствуйте! Отменила, выздоравливайте. Как поправитесь — напишите, подберём время.", after: 13 * 60 + 20 },
    ],
  },
  {
    key: "R10",
    channel: "WHATSAPP",
    who: "new",
    displayName: "Хадижат",
    daysAgo: 10,
    hour: 12.1,
    turns: [
      "Добрый день. Хочу записать двоих детей к остеопату, дочке 5 лет и сыну 2 года",
      { wait: 4 },
      "К Ирине Алилгаджиевне",
      { wait: 2 },
      "Да, согласна",
      { wait: 6 },
      "Алиева Марьям, 5 лет — сутулится. Алиев Али, 2 года — плохо спит. Мама Хадижат",
      { staff: "Хадижат, здравствуйте! Записала обоих к Ирине Алилгаджиевне на вторник, 6 октября: Марьям в 9:00, Али в 9:30.", after: 28 },
      { wait: 4 },
      "Спасибо 🙏",
    ],
    book: { staff: "irina", service: "Остеопатия - дети, прием Ирины", day: -6, minute: 9 * 60 },
  },
  {
    key: "R11",
    channel: "INSTAGRAM",
    who: "new",
    displayName: "leyla_dag",
    daysAgo: 11,
    hour: 21.3,
    turns: ["Сколько обычно нужно сеансов остеопатии?"],
  },
  {
    key: "R12",
    channel: "WHATSAPP",
    who: "new",
    displayName: "Эльмира",
    daysAgo: 12,
    hour: 11.6,
    turns: ["Здравствуйте, работаете в субботу? Хотела к Ирине Алилгаджиевне", { wait: 3 }, "Поняла. А к Разият в субботу можно? Для себя"],
  },
  {
    key: "R13",
    channel: "WHATSAPP",
    who: "new",
    displayName: "Диана",
    daysAgo: 13,
    hour: 16.8,
    turns: ["Что такое NAD+ и сколько стоит капельница?"],
  },
  {
    key: "R14",
    channel: "WHATSAPP",
    who: "new",
    displayName: "Написат",
    daysAgo: 14,
    hour: 10.2,
    turns: [
      "Здравствуйте. У сына ДЦП, 5 лет. Можно ли ему к вам на БОС-терапию и будет ли польза?",
      { staff: "Здравствуйте, Написат! Детей с ДЦП Ирина Омарова принимает — решение о курсе она принимает после диагностики, там же скажет, чего ждать. Могу записать на диагностику в понедельник, 5 октября, в 10:00?", after: 34 },
      { wait: 15 },
      "Да, давайте",
      { staff: "Записала. Возьмите, пожалуйста, выписки невролога 🙏", after: 6 },
    ],
    book: { staff: "omarova", service: "Диагностика/консультация на БОС-терапию", day: -7, minute: 10 * 60 },
  },
  {
    key: "R15",
    channel: "WHATSAPP",
    who: "new",
    displayName: "Саида",
    daysAgo: 16,
    hour: 13.4,
    turns: [
      "Ассаляму алейкум! Хочу записаться к Разият на пятницу",
      { wait: 3 },
      "Для себя, взрослый",
      { wait: 2 },
      "Согласна",
      { wait: 5 },
      "Магомедова Саида Расуловна, 35 лет, вес 60. Головные боли, шея",
      { staff: "Ва алейкум ассалам, Саида! Записала вас к Разият Ризвановне на пятницу, 2 октября, в 10:00.", after: 21 },
    ],
    book: { staff: "raziyat", service: "Остеопатия, прием Разият", day: -10, minute: 10 * 60 },
  },
  {
    key: "R16",
    channel: "TELEGRAM",
    who: "new",
    displayName: "Тимур",
    daysAgo: 18,
    hour: 18.7,
    turns: ["Здравствуйте, сколько стоит курс БОС и сколько он длится?", { wait: 6 }, "Для дочери 10 лет. Хотим записаться"],
  },
  {
    key: "R17",
    channel: "INSTAGRAM",
    who: "new",
    displayName: "amina.k",
    daysAgo: 20,
    hour: 12.9,
    turns: ["Можно ли сделать капельницу у вас на дому?"],
  },
  {
    key: "R18",
    channel: "WHATSAPP",
    who: "new",
    displayName: "Милана",
    daysAgo: 21,
    hour: 9.9,
    turns: [
      "С какого возраста принимаете детей к остеопату? Малышу 1 месяц",
      { wait: 5 },
      "Хотим записаться к Ирине Алилгаджиевне",
      { wait: 2 },
      "Да",
      { wait: 5 },
      "Абакаров Мурад, 1 месяц, мама Милана. Кривошея, выгибается",
      { staff: "Милана, здравствуйте! Записала Мурада к Ирине Алилгаджиевне на понедельник, 28 сентября, в 11:00.", after: 31 },
      { wait: 3 },
      "Спасибо!",
    ],
    book: { staff: "irina", service: "Остеопатия - дети, прием Ирины", day: -14, minute: 11 * 60 },
  },
  {
    key: "R19",
    channel: "WHATSAPP",
    who: "upcoming",
    displayName: "",
    daysAgo: 23,
    hour: 9.2,
    turns: ["Здравствуйте, немного опаздываю, буду минут через 15", { staff: "Хорошо, ждём вас!", after: 2, phone: true }],
  },
  {
    key: "R20",
    channel: "WHATSAPP",
    who: "recentChild",
    displayName: "",
    daysAgo: 25,
    hour: 19.1,
    turns: ["Огромное спасибо Ирине Алилгаджиевне! Ребёнку намного лучше, спит спокойно 🙏"],
  },
];

// ───────────────────────────────────────────── помощники

const TZ_OFFSET_MIN = 180;
const DAY = 24 * 3600_000;
function clinicMidnight(d: Date): Date {
  const local = new Date(d.getTime() + TZ_OFFSET_MIN * 60_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - TZ_OFFSET_MIN * 60_000);
}

let seed = 4242;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const between = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

const log = (s: string) => console.log(s);

async function main() {
  if (!process.argv.includes("--apply")) {
    console.log("Сухой прогон: ничего не меняю. --apply заведёт живые переписки (стоит денег на модель).");
    for (const s of SCENARIOS) console.log(`  ${s.key} ${s.channel} ${s.who} −${s.daysAgo} д: ${typeof s.turns[0] === "string" ? s.turns[0] : ""}`);
    return;
  }
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
  const company = await prisma.company.findFirstOrThrow({ where: { yclientsId: DEMO_YCLIENTS_ID } });
  const companyId = company.id;
  const now = new Date();
  const today = clinicMidnight(now);

  const users = Object.fromEntries(
    (await prisma.staffUser.findMany({ where: { companyId }, select: { login: true, id: true } })).map((u) => [u.login, u.id]),
  );
  const staffRows = await prisma.staff.findMany({ where: { companyId }, select: { id: true, name: true, defaultRoomId: true } });
  const staffBy: Record<StaffKey, { id: string; room: string | null }> = {
    irina: pickStaff("Ирина Алилгаджиевна"),
    raziyat: pickStaff("Мугадова Разият Ризвановна"),
    omarova: pickStaff("Ирина Омарова"),
    nuriyat: pickStaff("Нурият Абулкасимовна"),
    safiya: pickStaff("Сафия Гаджиевна"),
  };
  function pickStaff(name: string) {
    const s = staffRows.find((x) => x.name === name);
    if (!s) throw new Error(`нет сотрудника ${name}`);
    return { id: s.id, room: s.defaultRoomId };
  }
  const services = new Map(
    (await prisma.service.findMany({ where: { companyId }, select: { id: true, title: true, price: true, durationMin: true } })).map((s) => [s.title, s]),
  );

  const usedPatients = new Set<string>();
  /** Постоянный пациент под сценарий: без переписки и с нужной историей. */
  async function knownPatient(kind: Scenario["who"]): Promise<{ id: string; name: string; phone: string }> {
    const base = { companyId, deletedAt: null, conversations: { none: {} }, id: { notIn: [...usedPatients] } };
    const where =
      kind === "upcoming"
        ? { ...base, appointments: { some: { startAt: { gt: new Date(now.getTime() + DAY) }, status: { in: ["CREATED" as const, "CONFIRMED" as const] } } } }
        : kind === "stalledCourse"
          ? { ...base, courses: { some: { status: "ACTIVE" as const } }, appointments: { none: { startAt: { gt: now } } } }
          : kind === "recentIv"
            ? { ...base, appointments: { some: { status: "ARRIVED" as const, startAt: { gt: new Date(now.getTime() - 12 * DAY) }, primaryService: { kind: "IV_THERAPY" as const } } } }
            : { ...base, appointments: { some: { status: "ARRIVED" as const, startAt: { gt: new Date(now.getTime() - 40 * DAY) }, primaryService: { title: { contains: "дети" } } } } };
    const p = await prisma.patient.findFirst({
      where,
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, phones: { where: { isPrimary: true }, select: { phone: true } } },
    });
    if (!p?.phones[0]) throw new Error(`не нашёл пациента под «${kind}»`);
    usedPatients.add(p.id);
    return { id: p.id, name: p.name ?? "", phone: p.phones[0].phone };
  }

  const transcript: string[] = [];
  let phoneSeq = 0;

  for (const sc of SCENARIOS) {
    if (only && !only.includes(sc.key)) continue;
    const known = sc.who === "new" ? null : await knownPatient(sc.who);
    const phone = known?.phone ?? `+7900890${String(1000 + ++phoneSeq * 7).slice(-4)}`;
    const firstName = known ? (known.name.split(" ")[1] ?? known.name) : sc.displayName;
    const externalUserId =
      sc.channel === "WHATSAPP"
        ? `${phone.slice(1)}@c.us`
        : sc.channel === "TELEGRAM"
          ? String(700_000_000 + between(1, 9_999_999))
          : `ig-${between(10 ** 9, 2 * 10 ** 9)}`;

    // Старое от прошлого прогона — убрать: переписка должна быть ровно такой, как в сценарии.
    await prisma.conversation.deleteMany({ where: { companyId, channel: sc.channel, externalUserId } });
    if (!known) {
      /**
       * И карточку нового человека: история агента общая на пациента, и
       * согласие, данное в прошлом прогоне, сделало бы его «знакомым».
       */
      const stale = await prisma.patientPhone.findMany({ where: { companyId, phone }, select: { patientId: true } });
      const ids = stale.map((x) => x.patientId);
      if (ids.length) {
        await prisma.appointment.deleteMany({ where: { patientId: { in: ids } } });
        await prisma.conversation.deleteMany({ where: { patientId: { in: ids } } });
        await prisma.patient.deleteMany({ where: { id: { in: ids } } });
      }
    }

    log(`\n── ${sc.key} (${sc.channel}, ${known ? `постоянный: ${known.name}` : "новый"})`);
    transcript.push(`\n## ${sc.key} · ${sc.channel} · ${known ? known.name : sc.displayName}\n`);
    const realStart = new Date();

    for (const turn of sc.turns) {
      if (typeof turn !== "string" && "wait" in turn) continue;
      if (typeof turn !== "string" && "staff" in turn) {
        const conv = await prisma.conversation.findFirstOrThrow({ where: { companyId, channel: sc.channel, externalUserId } });
        await prisma.message.create({
          data: {
            companyId,
            conversationId: conv.id,
            channel: sc.channel,
            direction: "OUT",
            authorType: "STAFF",
            authorId: users[turn.by ?? "admin"] ?? null,
            body: turn.staff,
            status: "SENT",
            sentAt: new Date(),
            viaPlatform: !turn.phone,
          },
        });
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { status: "HUMAN_TAKEOVER", lastMessageAt: new Date(), botPausedUntil: new Date(Date.now() + 4 * 3600_000) },
        });
        transcript.push(`**Администратор:** ${turn.staff}\n`);
        log(`  админ: ${turn.staff.slice(0, 70)}`);
        continue;
      }
      const text = turn;
      transcript.push(`**Пациент:** ${text}\n`);
      const reply = await handlePatientMessage(
        { companyId, channel: sc.channel, externalUserId, displayName: firstName || null },
        { text, externalId: `demo-${randomUUID()}`, knownPhone: sc.channel === "WHATSAPP" ? phone : null },
      ).catch((e) => {
        log(`  СБОЙ: ${(e as Error).message}`);
        return null;
      });
      if (reply?.text) {
        // Ответ агента сохранён «в очереди» — отправку здесь делает сценарий, а не вебхук.
        await prisma.message.updateMany({
          where: { companyId, conversation: { externalUserId }, direction: "OUT", authorType: "BOT", status: "QUEUED" },
          data: { status: "SENT", sentAt: new Date() },
        });
        transcript.push(`**Агент:** ${reply.text}\n`);
        log(`  агент: ${reply.text.replace(/\n+/g, " ⏎ ").slice(0, 160)}`);
      } else {
        transcript.push(`**Агент:** _(промолчал — передал человеку или отвечать не на что)_\n`);
        log("  агент: —");
      }
    }

    const conv = await prisma.conversation.findFirst({ where: { companyId, channel: sc.channel, externalUserId } });
    if (!conv) continue;

    // Новый человек в Instagram/Telegram — карточку заводит администратор, когда записывает.
    let patientId = conv.patientId ?? known?.id ?? null;
    if (!patientId && sc.book) {
      patientId = (
        await prisma.patient.create({
          data: { companyId, name: sc.displayName, firstSeenAt: realStart, phones: { create: { companyId, phone, isPrimary: true } } },
        })
      ).id;
    }
    if (patientId && !conv.patientId) await prisma.conversation.update({ where: { id: conv.id }, data: { patientId } });

    await placeInTime(conv.id, patientId, sc, realStart);

    if (sc.book && patientId) await book(patientId, conv.id, sc.book);
    if (sc.key === "R2" || sc.key === "R9") await changeUpcoming(patientId, sc.key === "R9" ? "cancel" : "move", sc);
    await finish(conv.id);
  }

  // ── пересчёт того, что зависит от переписок: источники и первичные визиты
  const kinds = await recomputeVisitKinds(companyId);
  const src = await recomputeAppointmentSources(companyId);
  const psrc = await recomputePatientSources(companyId, {});
  log(`\nпересчёт: визиты ${kinds.updated}, источники визитов ${src.derived}, пациентов ${psrc.derived}`);

  const out = process.argv.find((a) => a.startsWith("--out="))?.slice(6);
  if (out) writeFileSync(out, transcript.join("\n"));

  // ─────────────────────────────────────── вложенные шаги

  /**
   * Перенести разговор на его день и час.
   *
   * Каждая отметка, сделанная во время разговора, переводится по кусочно-
   * линейной шкале: реальное время сообщения → время по сценарию. Так
   * эскалация, заведённая между двумя репликами, и в прошлом стоит между ними.
   */
  async function placeInTime(conversationId: string, patientId: string | null, sc: Scenario, realStart: Date) {
    const msgs = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
      select: { id: true, createdAt: true, direction: true, authorType: true },
    });
    /**
     * Паузы из сценария: перед каждой репликой пациента — сумма `wait` перед
     * ней, перед ответом сотрудника — его `after`. Ответ агента — через
     * несколько секунд после реплики, на которую он отвечает.
     */
    const gaps: { after: number | null }[] = [];
    let waited = 0;
    for (const turn of sc.turns) {
      if (typeof turn !== "string" && "wait" in turn) {
        waited += turn.wait;
        continue;
      }
      if (typeof turn !== "string" && "staff" in turn) gaps.push({ after: turn.after ?? null });
      else gaps.push({ after: waited || null });
      waited = 0;
    }
    let t = today.getTime() - sc.daysAgo * DAY + Math.round(sc.hour * 60) * 60_000;
    const points: [number, number][] = [[realStart.getTime(), t - 1000]];
    let gi = 0;
    for (const [i, m] of msgs.entries()) {
      if (m.authorType === "BOT") {
        if (i > 0) t += between(6, 35) * 1000;
      } else {
        const g = gaps[gi++]?.after ?? null;
        if (i > 0) {
          t += (g ?? (m.authorType === "STAFF" ? between(4, 25) : between(1, 6))) * 60_000 + between(0, 50) * 1000;
        }
      }
      points.push([m.createdAt.getTime(), t]);
    }
    // Ничего не должно оказаться в будущем.
    const overshoot = t - (now.getTime() - 60_000);
    if (overshoot > 0) for (const p of points) p[1] -= overshoot;
    const map = (d: Date | null): Date | null => {
      if (!d) return d;
      const x = d.getTime();
      let best = points[0];
      for (const p of points) if (p[0] <= x) best = p;
      return new Date(best[1] + Math.min(x - best[0], 20_000));
    };

    for (const m of msgs) {
      const row = await prisma.message.findUniqueOrThrow({ where: { id: m.id }, select: { createdAt: true, sentAt: true, deliveredAt: true, readAt: true, direction: true } });
      const created = map(row.createdAt)!;
      await prisma.message.update({
        where: { id: m.id },
        data: {
          createdAt: created,
          sentAt: row.direction === "OUT" ? created : map(row.sentAt),
          deliveredAt: row.direction === "OUT" ? new Date(created.getTime() + 2000) : map(row.deliveredAt),
          readAt: row.direction === "OUT" ? new Date(created.getTime() + between(1, 40) * 60_000) : map(row.readAt),
        },
      });
    }
    for (const e of await prisma.escalation.findMany({ where: { conversationId } })) {
      await prisma.escalation.update({
        where: { id: e.id },
        data: { createdAt: map(e.createdAt)!, notifiedAt: map(e.notifiedAt), acknowledgedAt: map(e.acknowledgedAt), resolvedAt: map(e.resolvedAt) },
      });
    }
    for (const r of await prisma.agentRun.findMany({ where: { conversationId } })) {
      await prisma.agentRun.update({
        where: { id: r.id },
        data: { triggeredAt: map(r.triggeredAt)!, finishedAt: map(r.finishedAt), createdAt: map(r.createdAt)! },
      });
    }
    for (const q of await prisma.inquiry.findMany({ where: { conversationId } })) {
      await prisma.inquiry.update({
        where: { id: q.id },
        data: { startedAt: map(q.startedAt)!, lastMessageAt: map(q.lastMessageAt)!, bookedAt: map(q.bookedAt), closedAt: map(q.closedAt), createdAt: map(q.createdAt)! },
      });
    }
    const c = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        startedAt: map(c.startedAt)!,
        lastMessageAt: map(c.lastMessageAt)!,
        lastPatientMessageAt: map(c.lastPatientMessageAt),
        consentAskedAt: map(c.consentAskedAt),
        consentGrantedAt: map(c.consentGrantedAt),
        botPausedUntil: map(c.botPausedUntil),
        remindedAt: map(c.remindedAt),
        createdAt: map(c.createdAt)!,
      },
    });
    if (patientId) {
      for (const pc of await prisma.patientConsent.findMany({ where: { patientId, grantedAt: { gte: realStart } } })) {
        await prisma.patientConsent.update({ where: { id: pc.id }, data: { grantedAt: map(pc.grantedAt)!, createdAt: map(pc.createdAt)! } });
      }
      const p = await prisma.patient.findUniqueOrThrow({ where: { id: patientId } });
      if (p.createdAt >= realStart) {
        await prisma.patient.update({
          where: { id: patientId },
          data: { firstSeenAt: map(p.firstSeenAt)!, createdAt: map(p.createdAt)!, sourceDerivedAt: map(p.sourceDerivedAt) },
        });
      }
    }
  }

  /** Запись, которую администратор сделал по итогам разговора. */
  async function book(patientId: string, conversationId: string, b: Booking) {
    const s = services.get(b.service);
    if (!s) throw new Error(`нет услуги ${b.service}`);
    const staff = staffBy[b.staff];
    const lastStaff = await prisma.message.findFirst({
      where: { conversationId, authorType: "STAFF" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    const createdAt = lastStaff ? new Date(lastStaff.createdAt.getTime() - 60_000) : new Date(now.getTime() - 3600_000);
    const startAt = new Date(today.getTime() + b.day * DAY + b.minute * 60_000);
    // В это время у врача уже кто-то есть — сдвигаем запись того, кто там стоял, на свободное место нельзя; двигаем нашу.
    for (let i = 0; i < 12; i++) {
      const clash = await prisma.appointment.findFirst({
        where: {
          staffId: staff.id,
          status: { not: "CANCELLED" },
          startAt: { lt: new Date(startAt.getTime() + s.durationMin * 60_000) },
          endAt: { gt: startAt },
        },
        select: { id: true },
      });
      if (!clash) break;
      // Тот, кто стоял на этом месте, уступает: так в расписании не будет двух людей сразу.
      await prisma.appointment.update({ where: { id: clash.id }, data: { status: "CANCELLED", cancelledAt: createdAt } });
    }
    const past = startAt.getTime() + s.durationMin * 60_000 < now.getTime();
    const revenue = Number(s.price);
    const appt = await prisma.appointment.create({
      data: {
        companyId,
        yclientsRecordId: 950_000_000 + between(1, 9_999_999),
        patientId,
        staffId: staff.id,
        roomId: staff.room,
        primaryServiceId: s.id,
        conversationId,
        startAt,
        endAt: new Date(startAt.getTime() + s.durationMin * 60_000),
        durationMin: s.durationMin,
        status: past ? "ARRIVED" : "CONFIRMED",
        attendanceRaw: past ? 1 : 0,
        revenue,
        revenueSource: "RECORD",
        isPaid: past,
        paidAmount: past ? revenue : 0,
        bookedByStaffUserId: users.admin ?? null,
        createdAtYclients: createdAt,
        updatedAtYclients: createdAt,
        syncState: "SYNCED",
        createdAt,
      },
    });
    await prisma.appointmentService.create({
      data: { companyId, appointmentId: appt.id, serviceId: s.id, priceCharged: revenue, durationMin: s.durationMin },
    });
    log(`  запись: ${b.service}, ${startAt.toISOString()}`);
  }

  /** Перенос и отмена — то, о чём просил пациент, в его ближайшей записи. */
  async function changeUpcoming(patientId: string | null, kind: "cancel" | "move", sc: Scenario) {
    if (!patientId) return;
    const next = await prisma.appointment.findFirst({
      where: { patientId, startAt: { gt: now }, status: { in: ["CREATED", "CONFIRMED"] } },
      orderBy: { startAt: "asc" },
    });
    if (!next) return;
    const lastStaff = await prisma.message.findFirst({
      where: { conversation: { patientId }, authorType: "STAFF" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    const when = lastStaff?.createdAt ?? new Date(today.getTime() - sc.daysAgo * DAY);
    if (kind === "cancel") {
      await prisma.appointment.update({ where: { id: next.id }, data: { status: "CANCELLED", cancelledAt: when } });
    } else {
      await prisma.appointmentMove.create({
        data: { companyId, appointmentId: next.id, patientId, fromStartAt: next.startAt, toStartAt: new Date(next.startAt.getTime() + 2 * DAY), detectedAt: when },
      }).catch(() => {});
      await prisma.appointment.update({
        where: { id: next.id },
        data: { startAt: new Date(next.startAt.getTime() + 2 * DAY), endAt: new Date(next.endAt.getTime() + 2 * DAY) },
      });
    }
  }

  /**
   * Итог разговора — как после работы администратора: на что ответили,
   * эскалация закрыта и прочитано; где последнее слово за пациентом и никто
   * не ответил — висит в «Нужен ответ».
   */
  async function finish(conversationId: string) {
    const msgs = await prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" } });
    const last = msgs[msgs.length - 1];
    const staffMsgs = msgs.filter((m) => m.authorType === "STAFF");
    const escalations = await prisma.escalation.findMany({ where: { conversationId } });
    const trailingIn = (() => {
      let n = 0;
      for (let i = msgs.length - 1; i >= 0 && msgs[i].direction === "IN"; i--) n++;
      return n;
    })();
    for (const e of escalations) {
      const answer = staffMsgs.find((m) => m.createdAt > e.createdAt);
      if (answer) {
        await prisma.escalation.update({
          where: { id: e.id },
          data: { status: "RESOLVED", resolvedById: answer.authorId, resolvedAt: answer.createdAt, acknowledgedById: answer.authorId, acknowledgedAt: answer.createdAt },
        });
      }
    }
    const open = await prisma.escalation.count({ where: { conversationId, status: { not: "RESOLVED" } } });
    const lastStaff = staffMsgs[staffMsgs.length - 1];
    const handedBack = lastStaff && now.getTime() - lastStaff.createdAt.getTime() > 4 * 3600_000;
    const answered = last && last.direction === "OUT";
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        status: open > 0 ? "ESCALATED" : lastStaff ? (handedBack ? "BOT_ACTIVE" : "HUMAN_TAKEOVER") : "BOT_ACTIVE",
        botPausedUntil: lastStaff ? new Date(lastStaff.createdAt.getTime() + 4 * 3600_000) : null,
        assignedToId: lastStaff?.authorId ?? null,
        lastMessageAt: last?.createdAt,
        // Прочитанным считается то, что видел администратор; свежее и неотвеченное — нет.
        staffReadAt: answered || (now.getTime() - (last?.createdAt.getTime() ?? 0) > 2 * DAY) ? last?.createdAt : null,
        unreadCount: answered ? 0 : trailingIn,
      },
    });
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
