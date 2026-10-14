import { z } from "zod";
import { BASE_URL, modelParams } from "@/lib/agent/llm";
import type { AdminIntent, DateRef, KnownService, KnownStaff } from "./admin-intents";
import { dateFrom, staffIn, serviceIn } from "./admin-intents";

/**
 * Понять поручение администратора — моделью; ответить — кодом.
 *
 * Правила разбора («сколько записано», «напиши Патимат: …») ломались на любой
 * живой фразе: «Кто у нас на завтра и на какие услуги?», «Предупреди Сумаю
 * (7988…) что нужно подтвердить запись», «Напиши Сумая — 7928… чтобы не
 * забывала о приёме» — и ассистент отвечал списком того, что умеет. Понимать
 * человеческую речь — работа модели. Считать и отправлять — по-прежнему код:
 * модель возвращает только РАЗБОР (что сделать, о ком, на какой день), а числа,
 * списки и получателей берут функции из базы, и отправка — только по кнопке.
 *
 * Что уходит модели: сам вопрос администратора (номера телефонов в нём
 * заменены на «[ТЕЛЕФОН]» — цифры остаются у нас), имена врачей и названия
 * услуг клиники. Ни одной строки из базы о пациентах — ни имён, ни визитов (§7).
 * Модель недоступна или ответила не по форме — разбирают прежние правила.
 */

export const UNDERSTOOD = z.object({
  action: z.enum([
    "schedule",
    "day_load",
    "day_money",
    "remaining",
    "now",
    "free_slots",
    "attendance",
    "waiting",
    "callbacks",
    "new_patients",
    "patient_info",
    "contacts",
    "find",
    "message_one",
    "broadcast",
    "explain",
    "period",
    "patients_total",
    "rooms",
    "booking_refusal",
    "medical_refusal",
    "child_refusal",
    "help",
    "unknown",
  ]),
  date: z.string().nullish(),
  staff: z.string().nullish(),
  service: z.string().nullish(),
  patient_name: z.string().nullish(),
  /** Пациент назван местоимением или «она/ей/этой» — из памяти разговора. */
  refers_to_previous: z.boolean().nullish(),
  message_text: z.string().nullish(),
  send_at: z.string().nullish(),
  audience: z.enum(["booked", "course", "school", "visited", "none"]).nullish(),
  school: z.string().nullish(),
  month: z.number().int().min(1).max(12).nullish(),
  period: z.enum(["last_week", "this_week", "last_month", "this_month", "week", "month"]).nullish(),
  course: z.boolean().nullish(),
  money: z.boolean().nullish(),
});
export type Understood = z.infer<typeof UNDERSTOOD>;

/** Телефоны из вопроса: цифры остаются у нас, модели — заглушка. */
export function maskPhones(question: string): { text: string; phones: string[] } {
  const phones: string[] = [];
  // Цифры с разделителями: «+7 (900) 712-09-05», «89007120905», «7900 712 0905».
  const text = question.replace(/\+?\d[\d\s()-]{8,17}\d/g, (m) => {
    const digits = m.replace(/\D/g, "");
    const ok = digits.length === 10 || (digits.length === 11 && /^[78]/.test(digits));
    if (!ok) return m;
    phones.push(digits.slice(-10));
    return " [ТЕЛЕФОН] ";
  });
  return { text: text.replace(/\s{2,}/g, " ").trim(), phones };
}

const ACTIONS_HELP = [
  "schedule — кто записан (поимённо) на день, можно с врачом или услугой: «кто завтра на БОС», «кто у нас на завтра и на какие услуги»",
  "day_load — сколько записано (число)",
  "day_money — на какую сумму записаны / сколько принято",
  "remaining — кто ещё остался сегодня",
  "now — кто сейчас на приёме, кто следующий",
  "free_slots — свободные окна",
  "attendance — кто не пришёл, неотмеченные",
  "waiting — кто ждёт ответа в переписке",
  "callbacks — кому позвонить",
  "new_patients — сколько новых пациентов",
  "patient_info — справка по пациенту (визиты, долг, курс, ближайшая запись)",
  "contacts — телефон пациента",
  "find — найти пациентов по имени/части/услуге/врачу/периоду/курсу",
  "message_one — написать ОДНОМУ пациенту (напиши, предупреди, напомни, сообщи ей…)",
  "broadcast — разослать нескольким (всем записанным, всем на курсе, всем от школы, всем кто был)",
  "explain — почему агент так ответил пациенту",
  "period — итоги за неделю/месяц",
  "patients_total — сколько пациентов в базе",
  "rooms — загрузка кабинетов",
  "booking_refusal — просьба записать/перенести/отменить приём (мы этого не делаем)",
  "medical_refusal — медицинский вопрос (противопоказания, лечение)",
  "child_refusal — привязать второго ребёнка к школе",
  "help — что умеешь",
  "unknown — ничего из перечисленного",
].join("\n");

function prompt(staff: KnownStaff[], services: KnownService[], todayIso: string): string {
  return [
    "Ты разбираешь поручение администратора частной клиники и возвращаешь ТОЛЬКО JSON-объект, без пояснений.",
    `Сегодня ${todayIso}.`,
    "Поля: action (одно из списка), date («today», «tomorrow», «yesterday», «day_after» или ГГГГ-ММ-ДД; null — не назван),",
    "staff (врач, как в списке врачей, или null), service (услуга, как в списке услуг, или null),",
    "patient_name (имя пациента так, как его назвал администратор, в именительном падеже; null — не назван),",
    "refers_to_previous (true, если пациент назван местоимением: ей, ему, она, этой, ей тоже),",
    "message_text (для message_one и broadcast: ГОТОВЫЙ вежливый текст сообщения пациенту от имени клиники, на «вы»,",
    "по смыслу поручения; не выдумывай дат, времени, врачей и цен — если для message_one нужны дата/время/врач/услуга его ближайшей записи,",
    "пиши {{date}}, {{time}}, {{doctor}}, {{service}}; имя пациента — {{name}}; в broadcast заготовки {{…}} не используй; если администратор дал текст после двоеточия или в кавычках — бери его дословно),",
    "send_at (когда отправить словами, как сказал администратор: «через час», «в 18:00», «завтра утром»; null — сразу),",
    "audience для broadcast (booked — записанным на день, course — на курсе, school — от школы, visited — кто был за период, none — без условия),",
    "school (название школы), month (1–12, для «в сентябре»), period (last_week, this_week, last_month, this_month, week, month),",
    "course (true — речь о курсе), money (true — спрашивают про деньги).",
    "Действия:",
    ACTIONS_HELP,
    `Врачи: ${staff.map((s) => s.name).join("; ") || "—"}.`,
    `Услуги: ${services.map((s) => s.title).slice(0, 120).join("; ") || "—"}.`,
    "Номера телефонов в вопросе заменены на [ТЕЛЕФОН] — это телефон пациента, о котором речь.",
  ].join("\n");
}

const TIMEOUT_MS = Number(process.env.ROUTER_AI_ADMIN_TIMEOUT_MS ?? 10_000);

/** Разобрать вопрос моделью. null — модели нет, она молчит или ответила не по форме. */
export async function understandAdmin(
  question: string,
  known: { staff: KnownStaff[]; services: KnownService[] },
  now: Date,
): Promise<Understood | null> {
  const key = process.env.ROUTER_AI;
  if (!key) return null;
  const { text } = maskPhones(question);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        ...modelParams(),
        temperature: 0,
        max_tokens: 700,
        messages: [
          { role: "system", content: prompt(known.staff, known.services, now.toISOString().slice(0, 10)) },
          { role: "user", content: text },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[ассистент] разбор вопроса: RouterAI ${res.status}`);
      return null;
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return parseUnderstood(json.choices?.[0]?.message?.content ?? "");
  } catch (e) {
    console.warn(`[ассистент] разбор вопроса: ${(e as Error)?.name ?? "ошибка"}`);
    return null;
  }
}

/** JSON из ответа модели: первый объект в тексте, проверенный схемой. */
export function parseUnderstood(raw: string): Understood | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = UNDERSTOOD.safeParse(JSON.parse(raw.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const DAY_WORD: Record<string, string> = { today: "сегодня", tomorrow: "завтра", yesterday: "вчера", day_after: "послезавтра" };

function dateRef(raw: string | null | undefined, now: Date): DateRef {
  if (!raw) return { offset: 0, iso: null, label: "сегодня" };
  if (DAY_WORD[raw]) return dateFrom(DAY_WORD[raw], now);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [, m, d] = raw.split("-").map(Number);
    const months = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
    return { offset: null, iso: raw, label: `${d} ${months[m - 1]}` };
  }
  return dateFrom(raw, now);
}

/**
 * Разбор модели → намерение, которое исполняет код. Врач и услуга
 * сверяются с НАШИМИ списками: модель могла назвать то, чего нет, — тогда
 * условие не ставится, а не угадывается.
 */
export function intentFrom(
  u: Understood,
  known: { staff: KnownStaff[]; services: KnownService[] },
  now: Date,
  sendAtFromText: (t: string) => Date | null,
): AdminIntent {
  const date = dateRef(u.date, now);
  const staff = u.staff ? staffIn(u.staff, known.staff) : { one: null, many: [] };
  const service = u.service ? serviceIn(u.service, known.services) : null;
  const staffId = staff.one?.id ?? null;
  const serviceId = service?.id ?? null;
  const name = u.patient_name?.trim() || "";
  const sendAt = u.send_at ? sendAtFromText(u.send_at) : null;
  switch (u.action) {
    case "schedule":
      return { kind: "schedule", date, staffId, serviceId };
    case "day_load":
      return { kind: "day_load", date, staffId, serviceId };
    case "day_money":
      return { kind: "day_money", date, staffId };
    case "remaining":
      return { kind: "remaining", date, staffId };
    case "now":
      return { kind: "now", staffId };
    case "free_slots":
      return { kind: "free_slots", date, staffId };
    case "attendance":
      return { kind: "attendance", date };
    case "waiting":
      return { kind: "waiting" };
    case "callbacks":
      return { kind: "callbacks" };
    case "new_patients":
      return { kind: "new_patients", date };
    case "patient_info":
      return { kind: "patient", name, question: "" };
    case "contacts":
      return { kind: "contacts", name };
    case "find":
      return {
        kind: "find",
        name: name || null,
        phoneDigits: null,
        staffId,
        serviceId,
        course: Boolean(u.course),
        period: u.period === "week" || u.period === "month" ? null : (u.period ?? null),
        date: u.date ? date : null,
      };
    case "message_one":
      return {
        kind: "message_one",
        name,
        text: u.message_text?.trim() ?? "",
        situation: null,
        delayText: null,
        sendAtIso: sendAt ? sendAt.toISOString() : null,
        date,
        staffId,
        serviceId,
      };
    case "broadcast":
      return {
        kind: "broadcast",
        date,
        staffId,
        serviceId,
        text: u.message_text?.trim() ?? "",
        situation: null,
        delayText: null,
        sendAtIso: sendAt ? sendAt.toISOString() : null,
        audience: u.audience ?? "none",
        schoolText: u.school ?? null,
        period: u.month ? "month" : u.period === "week" || u.period === "month" ? null : (u.period ?? null),
        month: u.month ? u.month - 1 : null,
      };
    case "explain":
      return { kind: "explain", name: name || null };
    case "period":
      return { kind: "period", period: u.period === "week" || u.period === "last_week" || u.period === "this_week" ? "week" : "month", money: Boolean(u.money) };
    case "patients_total":
      return { kind: "patients_total" };
    case "rooms":
      return { kind: "rooms", date };
    case "booking_refusal":
      return { kind: "booking_refusal" };
    case "medical_refusal":
      return { kind: "medical_refusal" };
    case "child_refusal":
      return { kind: "child_refusal" };
    case "help":
      return { kind: "help" };
    default:
      return { kind: "unknown" };
  }
}
