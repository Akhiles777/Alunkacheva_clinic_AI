import { randomUUID } from "node:crypto";
import { prisma } from "../lib/db";
import { handlePatientMessage } from "../lib/agent/clinic-agent";
import { BOT_MODEL } from "../lib/agent/llm";
import { recomputeAppointmentSources, recomputePatientSources, recomputeVisitKinds } from "../lib/metrics/recompute";
import { DEMO_YCLIENTS_ID } from "./demo-id";
import type { Channel } from "../generated/prisma/enums";

/**
 * История обращений демо-стенда: с чего начинались визиты.
 *
 * Без неё воронка показывает «обращений 0 — записались 400», источники
 * пациентов не выводятся из переписки, доля ответов из платформы пуста, а
 * «Что ассистент довёл до записи» — ноль. Вести через модель шестьсот
 * разговоров дорого и долго, а сочинять за агента нельзя (клиент спросит его
 * о том же и получит другой ответ). Поэтому так:
 *
 *   1. На каждый типовой разговор агент отвечает ОДИН раз, по-настоящему
 *      (запись ребёнка к Ирине, взрослый к Разият, БОС, капельницы, вопрос о
 *      здоровье, адрес). Его ответы — образцы.
 *   2. В переписках выдуманных пациентов повторяются эти ответы, а реплики
 *      пациента — свои: имя, возраст, жалоба. Запись делает администратор, как
 *      и в жизни (§6: расписанием агент не распоряжается).
 *
 * До запуска ассистента (`AGENT_START_DAYS` назад) отвечали только люди — и
 * часть ответов уходила с телефона клиники, а не из платформы.
 *
 *   DATABASE_URL=…/clinic_demo AGENT_DRILL=1 npx tsx --env-file=.env scripts/demo-history.ts --apply
 */

process.env.AGENT_DRILL = "1";

const AGENT_START_DAYS = 56;
const DAY = 24 * 3600_000;
const MIN = 60_000;

let seed = 777001;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const chance = (p: number) => rnd() < p;
const between = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

type Flow = "irinaChild" | "razChild" | "irinaAdult" | "razAdult" | "bos" | "iv" | "lotos" | "medical" | "address" | "price";

/**
 * Типовые разговоры. `{intake}` — анкета пациента, она у каждого своя;
 * остальные реплики одинаковы, и на них агент отвечает один раз.
 */
const FLOWS: Record<Flow, string[]> = {
  irinaChild: ["Здравствуйте! Хочу записать ребёнка к остеопату", "Ребёнку 4 года, к Ирине Алилгаджиевне", "Да", "{intake}"],
  razChild: ["Добрый день, сколько стоит детский приём остеопата?", "Хотим записаться к Разият Ризвановне, ребёнку 6 лет", "Да", "{intake}"],
  irinaAdult: ["Здравствуйте, хочу записаться к Ирине Алилгаджиевне", "Для себя, взрослый приём", "Согласна", "{intake}"],
  razAdult: ["Здравствуйте, сколько стоит приём остеопата?", "Для себя, к Разият Ризвановне", "Согласна", "{intake}"],
  bos: ["Здравствуйте, сколько стоит БОС-терапия для ребёнка?", "Хотим записаться на диагностику, сыну 8 лет", "Да", "{intake}"],
  iv: ["Здравствуйте, какие у вас есть капельницы и сколько они стоят?"],
  lotos: ["Что такое программа Лотос и сколько стоит?"],
  medical: ["Здравствуйте, у ребёнка плоскостопие, остеопат может помочь?"],
  address: ["Здравствуйте, где вы находитесь и как вас найти?"],
  price: ["Сколько стоит курс БОС и сколько длится?"],
};

/** Ответы агента на типовые разговоры — снимаются один раз, живым прогоном. */
async function captureReplies(companyId: string): Promise<Record<Flow, (string | null)[]>> {
  const out = {} as Record<Flow, (string | null)[]>;
  for (const [flow, turns] of Object.entries(FLOWS) as [Flow, string[]][]) {
    const phone = `+7900555${String(between(1000, 9999))}`;
    const externalUserId = `${phone.slice(1)}@c.us`;
    const replies: (string | null)[] = [];
    for (const raw of turns) {
      const text = raw === "{intake}" ? sampleIntake(flow) : raw;
      const reply = await handlePatientMessage(
        { companyId, channel: "WHATSAPP", externalUserId, displayName: null },
        { text, externalId: `cap-${randomUUID()}`, knownPhone: phone },
      ).catch(() => null);
      replies.push(reply?.text ?? null);
    }
    out[flow] = replies;
    console.log(`образец ${flow}: ${replies.map((r) => (r ?? "—").replace(/\s+/g, " ").slice(0, 70)).join(" | ")}`);
    // Образец — не переписка: убираем его вместе с карточкой.
    const conv = await prisma.conversation.findFirst({ where: { companyId, externalUserId }, select: { id: true, patientId: true } });
    if (conv) {
      await prisma.conversation.delete({ where: { id: conv.id } });
      if (conv.patientId) await prisma.patient.delete({ where: { id: conv.patientId } }).catch(() => {});
    }
  }
  return out;
}

const CHILD_NAMES_F = ["Амина", "Марьям", "Хадижат", "Фатима", "Патимат", "Айша", "Сафия", "Зайнаб", "Мадина", "Асият"];
const CHILD_NAMES_M = ["Ислам", "Мухаммад", "Али", "Умар", "Магомед", "Ахмад", "Абдулла", "Хасан", "Амир", "Юсуф"];
const CHILD_COMPLAINTS = ["плохо спит, беспокойный", "косолапит, жалуется на ноги", "сутулится", "кривошея", "часто болит голова", "гипертонус, выгибается", "после родовой травмы, направил невролог", "жалуется на спину после школы"];
const ADULT_COMPLAINTS = ["болит поясница", "головные боли, шея", "после травмы колена", "болит шея, немеют руки", "боли в спине после беременности", "сколиоз, тянет между лопатками"];
const BOS_COMPLAINTS = ["плохая концентрация, рассеянный", "тревожный, плохо спит", "задержка речи", "гиперактивный, не может усидеть"];

function sampleIntake(flow: Flow): string {
  return flow.endsWith("Child") || flow === "bos"
    ? "Алиев Ислам, 4 года, мама Зарема. Плохо спит"
    : "Курбанова Заира Ахмедовна, 41 год, вес 68. Болит поясница";
}

function intakeFor(flow: Flow, parentName: string, female: boolean): string {
  const [surname, first] = parentName.split(" ");
  const child = flow.endsWith("Child") || flow === "bos";
  if (child) {
    const girl = chance(0.5);
    const childSurname = girl && !surname.endsWith("а") ? `${surname}а` : !girl && surname.endsWith("а") ? surname.slice(0, -1) : surname;
    const age = flow === "bos" ? between(5, 12) : between(1, 9);
    const word = age === 1 ? "год" : age < 5 ? "года" : "лет";
    const complaint = flow === "bos" ? pick(BOS_COMPLAINTS) : pick(CHILD_COMPLAINTS);
    return `${childSurname} ${girl ? pick(CHILD_NAMES_F) : pick(CHILD_NAMES_M)}, ${age} ${word}, ${female ? "мама" : "папа"} ${first}. ${complaint[0].toUpperCase()}${complaint.slice(1)}`;
  }
  const age = between(24, 58);
  const complaint = pick(ADULT_COMPLAINTS);
  const years = age % 10 === 1 && age !== 11 ? "год" : age % 10 >= 2 && age % 10 <= 4 && (age < 12 || age > 14) ? "года" : "лет";
  return `${parentName}, ${age} ${years}, вес ${between(52, 92)}. ${complaint[0].toUpperCase()}${complaint.slice(1)}`;
}

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среду", "четверг", "пятницу", "субботу"];
function when(d: Date): string {
  const local = new Date(d.getTime() + 180 * MIN);
  const hh = local.getUTCHours();
  const mm = String(local.getUTCMinutes()).padStart(2, "0");
  return `${WEEKDAYS[local.getUTCDay()]}, ${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]}, в ${hh}:${mm}`;
}
/** Имя врача так, как его пишет администратор. */
function doctorWord(name: string): string {
  if (name.startsWith("Ирина Алилгаджиевна")) return "Ирине Алилгаджиевне";
  if (name.includes("Разият")) return "Разият Ризвановне";
  if (name.startsWith("Ирина Омарова")) return "Ирине Омаровой";
  if (name.startsWith("Нурият")) return "Нурият Абулкасимовне";
  if (name.startsWith("Сафия")) return "Сафие Гаджиевне";
  return name;
}

interface Msg {
  direction: "IN" | "OUT";
  authorType: "PATIENT" | "BOT" | "STAFF";
  body: string;
  at: Date;
  authorId?: string | null;
  viaPlatform?: boolean;
}

async function main() {
  if (!process.argv.includes("--apply")) {
    console.log("Сухой прогон. --apply снимет образцы ответов агента (около 30 запросов к модели) и заведёт историю обращений.");
    return;
  }
  const company = await prisma.company.findFirstOrThrow({ where: { yclientsId: DEMO_YCLIENTS_ID } });
  const companyId = company.id;
  const now = Date.now();
  const agentStart = now - AGENT_START_DAYS * DAY;

  // Прошлая история этого скрипта — убрать: переписки помечены приставкой адреса.
  await prisma.conversation.deleteMany({ where: { companyId, externalUserId: { startsWith: "h-" } } });
  await prisma.conversation.deleteMany({ where: { companyId, channel: "WHATSAPP", externalUserId: { startsWith: "79007" } } });

  const replies = await captureReplies(companyId);

  const users = Object.fromEntries((await prisma.staffUser.findMany({ where: { companyId }, select: { login: true, id: true } })).map((u) => [u.login, u.id]));
  const admins = [users.admin, users.admin2].filter(Boolean) as string[];
  const sources = Object.fromEntries((await prisma.source.findMany({ where: { companyId }, select: { code: true, id: true } })).map((s) => [s.code, s.id]));
  const consentDoc = await prisma.consentDocument.findFirstOrThrow({ where: { companyId, isActive: true } });

  // Пациенты и их первая запись.
  const patients = await prisma.patient.findMany({
    where: { companyId, yclientsId: { not: null }, deletedAt: null },
    select: {
      id: true,
      name: true,
      sourceId: true,
      source: { select: { code: true } },
      phones: { where: { isPrimary: true }, select: { phone: true } },
      appointments: {
        orderBy: { createdAtYclients: "asc" },
        select: {
          id: true,
          startAt: true,
          createdAtYclients: true,
          status: true,
          staff: { select: { name: true } },
          primaryService: { select: { title: true, kind: true } },
        },
      },
    },
  });

  let convCount = 0;
  let msgCount = 0;
  const runs: { conversationId: string; at: Date; messageAt: Date }[] = [];

  for (const p of patients) {
    const first = p.appointments[0];
    if (!first || !p.phones[0] || !p.name) continue;
    const code = p.source?.code ?? null;
    // Пришёл звонком, сам или по рекомендации — переписки перед визитом не было.
    if (code && !["whatsapp", "instagram", "telegram"].includes(code)) continue;
    // Клиника живёт в WhatsApp: большинство первых записей начинается с переписки.
    if (!code && !chance(0.8)) continue;
    const channel: Channel = code === "instagram" ? "INSTAGRAM" : code === "telegram" ? "TELEGRAM" : code === "whatsapp" ? "WHATSAPP" : pick(["WHATSAPP", "WHATSAPP", "WHATSAPP", "INSTAGRAM", "INSTAGRAM", "TELEGRAM"] as Channel[]);

    const title = first.primaryService?.title ?? "";
    const doctor = first.staff.name;
    const female = /а$|я$/.test(p.name.split(" ")[0] ?? "");
    const firstName = p.name.split(" ")[1] ?? p.name;
    const flow: Flow | null = title.includes("дети") && doctor.startsWith("Ирина Алилг")
      ? "irinaChild"
      : title.includes("дети")
        ? "razChild"
        : doctor.startsWith("Ирина Алилг")
          ? "irinaAdult"
          : doctor.includes("Разият")
            ? "razAdult"
            : first.primaryService?.kind === "BIOFEEDBACK"
              ? "bos"
              : title.includes("Лотос")
                ? "lotos"
                : first.primaryService?.kind === "IV_THERAPY"
                  ? "iv"
                  : null;
    if (!flow) continue;

    const booked = first.createdAtYclients.getTime();
    const start = booked - between(25, 180) * MIN;
    const agentEra = start >= agentStart;
    const msgs: Msg[] = [];
    let t = start;
    const admin = pick(admins);
    // До платформы администратор отвечал с телефона клиники; потом — в основном из платформы.
    const viaPlatform = agentEra ? chance(0.82) : chance(0.25);
    const staff = (body: string, at: number) => msgs.push({ direction: "OUT", authorType: "STAFF", body, at: new Date(at), authorId: admin, viaPlatform });
    const patient = (body: string, at: number) => msgs.push({ direction: "IN", authorType: "PATIENT", body, at: new Date(at) });
    const bot = (body: string | null, at: number) => {
      if (body) msgs.push({ direction: "OUT", authorType: "BOT", body, at: new Date(at) });
    };
    const booking = `${firstName}, здравствуйте! Записала вас к ${doctorWord(doctor)} на ${when(first.startAt)}. Если что-то изменится — напишите здесь 🌿`;

    let consentAt: number | null = null;
    let escalationAt: number | null = null;
    if (agentEra && FLOWS[flow].length > 1 && chance(0.85)) {
      // Весь путь записи ведёт ассистент, администратор ставит время.
      const turns = FLOWS[flow];
      const r = replies[flow];
      for (const [i, raw] of turns.entries()) {
        patient(raw === "{intake}" ? intakeFor(flow, p.name, female) : raw, t);
        if (raw === "Да" || raw === "Согласна") consentAt = t;
        t += between(8, 40) * 1000;
        bot(r[i], t);
        t += between(1, 6) * MIN;
      }
      t = Math.max(t + between(5, 40) * MIN, booked);
      staff(booking, t);
    } else if (agentEra) {
      // Короткий вопрос — ответ ассистента — «хочу записаться» — администратор.
      const quick: Flow = flow === "iv" || flow === "lotos" ? flow : chance(0.2) ? "medical" : chance(0.5) ? "address" : flow === "bos" ? "price" : "address";
      patient(FLOWS[quick][0], t);
      t += between(8, 40) * 1000;
      bot(replies[quick][0], t);
      if (quick === "medical") escalationAt = t;
      t += between(2, 30) * MIN;
      patient(pick(["Хочу записаться", "Можно записаться?", "Запишите, пожалуйста", "А когда можно прийти?"]), t);
      t = Math.max(t + between(5, 50) * MIN, booked);
      if (quick === "medical") {
        staff("Здравствуйте! Остеопат работает и с плоскостопием — сначала осмотр, по нему врач скажет, сколько нужно сеансов.", t - 2 * MIN);
      }
      staff(booking, t);
    } else {
      // До ассистента: отвечал человек.
      patient(pick(["Здравствуйте! Сколько стоит приём?", "Добрый день, можно записаться?", "Здравствуйте, есть свободное время на этой неделе?", "Ассаляму алейкум, хотим записаться"]), t);
      t = Math.max(t + between(10, 120) * MIN, booked);
      staff(booking, t);
    }
    t += between(2, 25) * MIN;
    patient(pick(["Спасибо!", "Спасибо большое 🙏", "Хорошо, спасибо", "Благодарю", "Ок, придём"]), t);

    // Напоминание накануне — из платформы; у постоянных — повторные записи через ту же переписку.
    for (const a of p.appointments.slice(1, 8)) {
      if (a.createdAtYclients.getTime() <= t) continue;
      if (chance(0.8)) {
        const ask = a.createdAtYclients.getTime() - between(10, 120) * MIN;
        patient(pick(["Здравствуйте, можно записаться ещё раз?", "Добрый день! Нам снова нужно к врачу", "Запишите нас, пожалуйста, на следующий приём"]), ask);
        staff(`Здравствуйте! Записала на ${when(a.startAt)} к ${doctorWord(a.staff.name)}.`, a.createdAtYclients.getTime());
        patient("Спасибо!", a.createdAtYclients.getTime() + between(3, 30) * MIN);
      }
    }
    const nextAppt = p.appointments.find((a) => a.startAt.getTime() > now + 12 * 3600_000 && a.startAt.getTime() < now + 2 * DAY && a.status !== "CANCELLED");
    if (nextAppt && chance(0.7)) {
      // Напоминание — накануне днём, в рабочее время.
      const local = new Date(nextAppt.startAt.getTime() + 180 * MIN);
      const dayBefore = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - 1) - 180 * MIN;
      const remindAt = Math.min(dayBefore + between(10 * 60, 15 * 60) * MIN, now - between(30, 300) * MIN);
      if (remindAt > (msgs[msgs.length - 1]?.at.getTime() ?? 0)) {
        msgs.push({ direction: "OUT", authorType: "STAFF", body: `Здравствуйте! Напоминаем о записи на ${when(nextAppt.startAt)} к ${doctorWord(nextAppt.staff.name)}. Ждём вас!`, at: new Date(remindAt), authorId: admin, viaPlatform: true });
        if (chance(0.7)) patient(pick(["Да, придём", "Спасибо, будем", "👍"]), remindAt + between(5, 90) * MIN);
      }
    }

    msgs.sort((a, b) => a.at.getTime() - b.at.getTime());
    if (msgs[msgs.length - 1].at.getTime() > now) continue;
    const last = msgs[msgs.length - 1];
    const lastIn = [...msgs].reverse().find((m) => m.direction === "IN");
    const phone = p.phones[0].phone;
    const externalUserId =
      channel === "WHATSAPP" ? `${phone.slice(1)}@c.us` : channel === "TELEGRAM" ? `h-tg-${between(10 ** 8, 9 * 10 ** 8)}` : `h-ig-${between(10 ** 9, 9 * 10 ** 9)}`;
    const conv = await prisma.conversation.create({
      data: {
        companyId,
        patientId: p.id,
        channel,
        externalUserId,
        contactName: channel === "INSTAGRAM" ? `${firstName.toLowerCase()}_${between(10, 99)}` : firstName,
        phoneE164: channel === "WHATSAPP" ? phone : null,
        sourceId: sources[channel.toLowerCase()] ?? null,
        status: "BOT_ACTIVE",
        startedAt: msgs[0].at,
        lastMessageAt: last.at,
        lastPatientMessageAt: lastIn?.at ?? null,
        staffReadAt: last.at,
        consentAskedAt: consentAt ? new Date(consentAt - 2 * MIN) : null,
        consentGrantedAt: consentAt ? new Date(consentAt) : null,
        botPausedUntil: null,
        createdAt: msgs[0].at,
      },
    });
    await prisma.message.createMany({
      data: msgs.map((m) => ({
        companyId,
        conversationId: conv.id,
        channel,
        direction: m.direction,
        authorType: m.authorType,
        authorId: m.authorId ?? null,
        body: m.body,
        status: "SENT" as const,
        viaPlatform: m.viaPlatform ?? false,
        sentAt: m.at,
        deliveredAt: m.direction === "OUT" ? new Date(m.at.getTime() + 3000) : null,
        readAt: m.direction === "OUT" ? new Date(m.at.getTime() + between(1, 60) * MIN) : null,
        createdAt: m.at,
      })),
    });
    for (const m of msgs.filter((x) => x.authorType === "BOT")) {
      runs.push({ conversationId: conv.id, at: new Date(m.at.getTime() - between(1500, 7000)), messageAt: m.at });
    }
    if (consentAt) {
      await prisma.patientConsent.upsert({
        where: { patientId_documentId: { patientId: p.id, documentId: consentDoc.id } },
        update: { grantedAt: new Date(consentAt), channel },
        create: { companyId, patientId: p.id, documentId: consentDoc.id, grantedAt: new Date(consentAt), channel },
      });
    }
    if (escalationAt) {
      const answer = msgs.find((m) => m.authorType === "STAFF" && m.at.getTime() > escalationAt!);
      await prisma.escalation.create({
        data: {
          companyId,
          conversationId: conv.id,
          reason: "MEDICAL_QUESTION",
          reasonText: "Медицинский вопрос без готового ответа в справочнике",
          status: "RESOLVED",
          createdAt: new Date(escalationAt),
          notifiedAt: new Date(escalationAt),
          resolvedAt: answer?.at ?? null,
          resolvedById: answer?.authorId ?? null,
          acknowledgedAt: answer?.at ?? null,
          acknowledgedById: answer?.authorId ?? null,
        },
      });
    }
    convCount += 1;
    msgCount += msgs.length;
  }

  /**
   * Обращения без записи: спросили адрес или цену и пропали. Без них
   * «обращения → записались» шло бы один к одному, а так не бывает.
   */
  let leads = 0;
  for (let i = 0; i < 320; i++) {
    // Пишут днём и вечером по часам клиники (UTC+3), а не в любую минуту суток.
    const dayAgo = new Date(now - between(1, 120) * DAY + 180 * MIN);
    const at = Date.UTC(dayAgo.getUTCFullYear(), dayAgo.getUTCMonth(), dayAgo.getUTCDate()) - 180 * MIN + between(9 * 60, 21 * 60) * MIN;
    const flow = pick(["address", "price", "iv", "lotos", "medical"] as Flow[]);
    const channel = pick(["INSTAGRAM", "INSTAGRAM", "WHATSAPP", "TELEGRAM"] as Channel[]);
    const agentEra = at >= agentStart;
    const first = FLOWS[flow][0];
    const msgs: Msg[] = [{ direction: "IN", authorType: "PATIENT", body: first, at: new Date(at) }];
    if (agentEra && replies[flow][0]) {
      msgs.push({ direction: "OUT", authorType: "BOT", body: replies[flow][0]!, at: new Date(at + between(8, 40) * 1000) });
      if (chance(0.4)) msgs.push({ direction: "IN", authorType: "PATIENT", body: pick(["Спасибо", "Понятно, спасибо", "Подумаю", "👍"]), at: new Date(at + between(3, 30) * MIN) });
    } else {
      msgs.push({ direction: "OUT", authorType: "STAFF", body: pick(["Здравствуйте! Мы на ул. Островского, 20А, 2 этаж. Работаем пн–пт 8:00–16:00, сб 9:00–16:00.", "Здравствуйте! Подскажите, для кого приём и к какому врачу — назову цены.", "Здравствуйте! Курс БОС — 28 000 ₽, 10 занятий по 40 минут. Начинаем с диагностики за 1000 ₽."]), at: new Date(at + between(15, 180) * MIN), authorId: pick(admins), viaPlatform: chance(0.3) });
    }
    const phone = `+7900666${String(1000 + i * 13).slice(-4)}`;
    const externalUserId = channel === "WHATSAPP" ? `${phone.slice(1)}@c.us` : `h-lead-${channel.toLowerCase()}-${i}`;
    const conv = await prisma.conversation.create({
      data: {
        companyId,
        channel,
        externalUserId,
        contactName: channel === "INSTAGRAM" ? pick(["madina", "zarema", "aminat", "patya", "dina", "saida", "leyla"]) + `_${between(1, 999)}` : pick(["Мадина", "Зарема", "Аминат", "Патимат", "Диана", "Саида", "Лейла", "Руслан", "Магомед"]),
        phoneE164: channel === "WHATSAPP" ? phone : null,
        sourceId: sources[channel.toLowerCase()] ?? null,
        status: "BOT_ACTIVE",
        startedAt: msgs[0].at,
        lastMessageAt: msgs[msgs.length - 1].at,
        lastPatientMessageAt: [...msgs].reverse().find((m) => m.direction === "IN")!.at,
        staffReadAt: msgs[msgs.length - 1].at,
        createdAt: msgs[0].at,
      },
    });
    await prisma.message.createMany({
      data: msgs.map((m) => ({
        companyId,
        conversationId: conv.id,
        channel,
        direction: m.direction,
        authorType: m.authorType,
        authorId: m.authorId ?? null,
        body: m.body,
        status: "SENT" as const,
        viaPlatform: m.viaPlatform ?? false,
        sentAt: m.at,
        deliveredAt: m.direction === "OUT" ? new Date(m.at.getTime() + 3000) : null,
        readAt: m.direction === "OUT" ? new Date(m.at.getTime() + between(1, 60) * MIN) : null,
        createdAt: m.at,
      })),
    });
    for (const m of msgs.filter((x) => x.authorType === "BOT")) runs.push({ conversationId: conv.id, at: new Date(m.at.getTime() - between(1500, 7000)), messageAt: m.at });
    if (flow === "medical" && agentEra) {
      await prisma.escalation.create({
        data: { companyId, conversationId: conv.id, reason: "MEDICAL_QUESTION", reasonText: "Медицинский вопрос без готового ответа в справочнике", status: "RESOLVED", createdAt: msgs[1]?.at ?? msgs[0].at, resolvedAt: new Date(at + 40 * MIN), resolvedById: pick(admins) },
      });
    }
    leads += 1;
    msgCount += msgs.length;
  }

  // Журнал попыток агента — по каждому ответу ассистента, как его пишет сам агент.
  await prisma.agentRun.createMany({
    data: runs.map((r) => {
      const latency = r.messageAt.getTime() - r.at.getTime();
      return {
        companyId,
        conversationId: r.conversationId,
        triggeredAt: r.at,
        finishedAt: r.messageAt,
        latencyMs: latency,
        outcome: "OK" as const,
        model: BOT_MODEL,
        promptTokens: between(2600, 6200),
        completionTokens: between(60, 260),
        createdAt: r.at,
      };
    }),
  });

  const kinds = await recomputeVisitKinds(companyId);
  const src = await recomputeAppointmentSources(companyId);
  const psrc = await recomputePatientSources(companyId, {});
  console.log(`\nпереписок ${convCount} + обращений без записи ${leads}, сообщений ${msgCount}, ответов ассистента ${runs.length}`);
  console.log(`пересчёт: визиты ${kinds.updated}, источники визитов ${src.derived}, пациентов ${psrc.derived}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
