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

export interface LastVisit {
  staff: { id: string; name: string };
  /** Основная услуга прошлого визита; null — в записи её нет. */
  serviceId: string | null;
  serviceTitle: string | null;
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
      take: 5,
      select: {
        status: true,
        staff: { select: { id: true, name: true } },
        primaryService: { select: { id: true, title: true } },
      },
    })
    .catch(() => []);
  // Состоявшийся визит надёжнее неразобранного: отметку «пришёл» ставят не всегда, но если стоит — ей верим.
  const row = rows.find((r) => r.status === "ARRIVED") ?? rows[0];
  if (!row?.staff) return null;
  return {
    staff: row.staff,
    serviceId: row.primaryService?.id ?? null,
    serviceTitle: row.primaryService?.title ?? null,
  };
}
