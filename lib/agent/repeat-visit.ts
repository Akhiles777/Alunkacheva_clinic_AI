import { prisma } from "@/lib/db";

/**
 * «Повторный приём» — к тому же врачу и на ту же услугу, что в прошлый раз.
 *
 * Живой диалог 5 октября: постоянная пациентка написала «Я всё-таки хотела бы
 * на повторный приём попасть» — и агент назвал цены обоих остеопатов и спросил
 * «к какому врачу вы хотели бы записаться?», а следующей репликой спросил это
 * ещё раз. Ответ лежал в её карточке: повторный приём — это к тому, у кого она
 * была. Переспрашивать то, что клиника о человеке знает, — ровно то, что
 * выдаёт автоответчик.
 *
 * Слова повтора узнаются здесь, а сам прошлый визит берётся из базы
 * (`lastVisit`): врача по словам «как в прошлый раз» не угадываем — его
 * называет запись.
 */
const REPEAT = [
  /(?<!\p{L})повторн\p{L}*/iu,
  /(?<!\p{L})(?:ещ[её]\s+раз|снова|опять|как\s+в\s+прошлый\s+раз|как\s+раньше)(?!\p{L})/iu,
  /(?<!\p{L})к\s+(?:сво\p{L}*|тому\s+же|этому\s+же|той\s+же|нашему|нашей)\s+(?:врач|доктор|специалист|остеопат)\p{L}*/iu,
  /(?<!\p{L})продолж\p{L}*\s+(?:лечени|курс|заняти|сеанс|приём|прием)\p{L}*/iu,
];

export function asksRepeatVisit(text: string): boolean {
  return REPEAT.some((re) => re.test(text));
}

export interface VisitedDoctor {
  staff: { id: string; name: string };
  /** Основная услуга прошлого визита; null — в записи её нет. */
  serviceId: string | null;
  serviceTitle: string | null;
}

export interface LastVisit extends VisitedDoctor {
  /** Все врачи недавних визитов, свежие первыми, у каждого — его последняя услуга. */
  visited: VisitedDoctor[];
}

/**
 * Последний состоявшийся (или хотя бы не отменённый) прошлый визит пациента —
 * с врачом, который сейчас работает. Пусто — карточки нет, визитов нет или врач
 * больше не принимает: тогда врача спрашиваем, как обычно.
 */
export async function lastVisit(companyId: string, patientId: string | null, now = new Date()): Promise<LastVisit | null> {
  if (!patientId) return null;
  const rows = await prisma.appointment
    .findMany({
      where: {
        companyId,
        patientId,
        deletedAt: null,
        status: { notIn: ["CANCELLED", "NO_SHOW"] },
        startAt: { lt: now },
        staff: { isActive: true, deletedAt: null },
      },
      orderBy: [{ startAt: "desc" }],
      take: 20,
      select: {
        status: true,
        staff: { select: { id: true, name: true } },
        primaryService: { select: { id: true, title: true } },
      },
    })
    .catch(() => []);
  // Состоявшийся визит надёжнее неразобранного: отметку «пришёл» ставят не всегда, но если стоит — ей верим.
  const row = rows.slice(0, 5).find((r) => r.status === "ARRIVED") ?? rows[0];
  if (!row?.staff) return null;
  /**
   * У этого врача были и взрослые, и детские визиты — услугу прошлого визита
   * не угадываем. «Хочу к Разият на повторный приём»: мама ходила к ней и сама,
   * и с ребёнком, последним был детский — и агент молча назвал детский приём
   * (проверка 9 октября). Врач известен, а для кого — спрашиваем.
   */
  const childish = (title: string | undefined) => !!title && /(?<!\p{L})(?:дет[си]|реб[её]н|подрост)/iu.test(title);
  const mixed = (staffId: string) => {
    const kinds = new Set(
      rows.filter((r) => r.staff?.id === staffId && r.primaryService).map((r) => childish(r.primaryService?.title)),
    );
    return kinds.size > 1;
  };
  const visitOf = (r: (typeof rows)[number]): VisitedDoctor =>
    mixed(r.staff.id)
      ? { staff: r.staff, serviceId: null, serviceTitle: null }
      : { staff: r.staff, serviceId: r.primaryService?.id ?? null, serviceTitle: r.primaryService?.title ?? null };
  const visited: VisitedDoctor[] = [];
  for (const r of rows) {
    if (!r.staff || visited.some((v) => v.staff.id === r.staff.id)) continue;
    visited.push(visitOf(r));
  }
  return { ...visitOf(row), visited };
}

/**
 * К кому «повторный приём», если человек назвал врача.
 *
 * Прогон 5 октября: «Хочу ещё раз к Ирине записаться» — пациентка ходила и к
 * Ирине Алилгаджиевне (остеопатия), и к Ирине Омаровой (БОС), последней была
 * у второй, и агент назвал БОС, хотя речь могла идти об остеопатии. Имя
 * подходит к ДВУМ врачам, у которых человек бывал, — угадывать нельзя, это
 * вопрос (`clash`). Подходит к одному — к нему, даже если последний визит был
 * к другому врачу: «ещё раз к Ирине» после визита к Разият — это к Ирине.
 *
 * `namedIds` — врачи, которых человек назвал (однозначно названный — один).
 */
export function repeatDoctor(last: LastVisit, namedIds: string[]): { pick: LastVisit | null; clash: VisitedDoctor[] } {
  if (namedIds.length === 0) return { pick: last, clash: [] };
  const among = last.visited.filter((v) => namedIds.includes(v.staff.id));
  if (among.length === 1) {
    const v = among[0];
    return { pick: v.staff.id === last.staff.id ? last : { ...v, visited: last.visited }, clash: [] };
  }
  return { pick: null, clash: among.length >= 2 ? among : [] };
}

/** Сколько дней после визита разговор о той же услуге считается продолжением. */
export const CONTINUING_DAYS = 30;

/**
 * Пациент уже ходит на эту услугу: идёт курс, впереди запись или был на ней
 * последние `CONTINUING_DAYS` дней. Тогда «на БОС-терапию на какой день можно
 * записать мальчика?» — выбор дня, а не новая запись, и анкета не нужна (живой
 * диалог 21 октября: мама, чей сын уже записан на курс БОС, получила просьбу
 * прислать ФИО ребёнка, возраст и имя родителя).
 *
 * «Та же услуга» — тот же вид из справочника (`Service.kind`: курс БОС и сеанс
 * БОС — одна услуга для пациента), а у вида «прочее» — та же строка прайса.
 * Прошлые визиты дальше месяца сюда не идут: «детские визиты в карточке
 * родителя» ещё не значат, что записывают того же ребёнка (6 октября).
 */
export async function continuingService(
  companyId: string,
  patientId: string | null,
  serviceIds: string[],
  now = new Date(),
): Promise<{ title: string } | null> {
  if (!patientId || serviceIds.length === 0) return null;
  const named = await prisma.service.findMany({ where: { companyId, id: { in: serviceIds } }, select: { id: true, kind: true } });
  const kinds = [...new Set(named.map((s) => s.kind).filter((k) => k !== "OTHER"))];
  const sameService = { OR: [{ id: { in: serviceIds } }, ...(kinds.length ? [{ kind: { in: kinds } }] : [])] };
  const course = await prisma.course.findFirst({
    where: { companyId, patientId, status: "ACTIVE", service: sameService },
    select: { service: { select: { title: true } } },
  });
  if (course) return { title: course.service.title };
  const visit = await prisma.appointment.findFirst({
    where: {
      companyId,
      patientId,
      deletedAt: null,
      status: { notIn: ["CANCELLED", "NO_SHOW"] },
      startAt: { gte: new Date(now.getTime() - CONTINUING_DAYS * 86_400_000) },
      services: { some: { service: sameService } },
    },
    orderBy: { startAt: "desc" },
    select: { services: { select: { service: { select: { title: true } } }, take: 1 } },
  });
  return visit ? { title: visit.services[0]?.service.title ?? "" } : null;
}
