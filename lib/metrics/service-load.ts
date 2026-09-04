/**
 * Загрузка по услугам — основной разрез метрики загрузки (§8).
 *
 * Специалисты меняются кабинетами, поэтому «сколько работает услуга» точнее,
 * чем «сколько занят кабинет». Определение:
 *
 *   загрузка услуги = занятые минуты по услуге
 *                     / доступные минуты кабинетов, где услуга может проводиться
 *
 * Знаменатель — сумма рабочих минут всех кабинетов из привязки услуги
 * (ServiceRoom). Если услуга идёт в двух кабинетах, знаменатель — их суммарное
 * рабочее время: две капельницы параллельно — это 100% на один кабинет, но 50%
 * на услугу с двумя кабинетами.
 */

export interface ServiceApptInput {
  serviceId: string;
  durationMin: number;
}

export interface ServiceLoad {
  serviceId: string;
  busyMinutes: number;
  availableMinutes: number;
  /** 0..1, срезано по 1. */
  ratio: number;
}

/**
 * @param appts        приёмы за период (уже отфильтрованные вызывающим — напр.
 *                     не отменённые); каждый вносит durationMin в свою услугу
 * @param serviceRooms услуга → список кабинетов, где она разрешена
 * @param roomMinutes  кабинет → доступные рабочие минуты за период
 */
export function loadByService(
  appts: ServiceApptInput[],
  serviceRooms: Record<string, string[]>,
  roomMinutes: Record<string, number>,
): ServiceLoad[] {
  const busy = new Map<string, number>();
  for (const a of appts) {
    busy.set(a.serviceId, (busy.get(a.serviceId) ?? 0) + Math.max(a.durationMin, 0));
  }

  // Услуги — из привязки к кабинетам (это она задаёт знаменатель), плюс те,
  // по которым были приёмы даже без привязки (иначе занятость потеряется).
  const serviceIds = new Set<string>([...Object.keys(serviceRooms), ...busy.keys()]);

  const result: ServiceLoad[] = [];
  for (const serviceId of serviceIds) {
    const rooms = serviceRooms[serviceId] ?? [];
    const availableMinutes = rooms.reduce((sum, roomId) => sum + (roomMinutes[roomId] ?? 0), 0);
    const busyMinutes = busy.get(serviceId) ?? 0;
    const ratio = availableMinutes > 0 ? Math.min(busyMinutes / availableMinutes, 1) : 0;
    result.push({ serviceId, busyMinutes, availableMinutes, ratio });
  }

  return result.sort((a, b) => b.ratio - a.ratio);
}

/**
 * Почему у услуги нет приёмов за период.
 *
 * Строка «Без приёмов за период — 31» перечисляла подряд всё, у чего ноль:
 * дубли справочника, служебные позиции и настоящие незаказанные услуги. На
 * экране это читалось как «остеопатию Ирины никто не берёт», хотя приёмы по
 * ней идут каждый день — просто записаны на другую строку с тем же названием.
 *
 * Разные причины требуют разных действий: дубль надо слить, служебную позицию
 * не трогать, а незаказанную услугу обсуждать с клиникой. Сваленные в кучу,
 * они не значат ничего.
 */
export type IdleReason = "DUPLICATE" | "STAFF_ONLY" | "NO_PRICE" | "NOT_ORDERED";

export interface IdleService {
  title: string;
  reason: IdleReason;
}

export interface ServiceRowForIdle {
  title: string;
  appointments: number;
  /** Цена по прайсу: 0 и 1 ₽ — заготовки, а не услуги. */
  price: number;
}

/**
 * Название для сравнения: регистр, «ё», кавычки и лишние пробелы не должны
 * делать из одной услуги две.
 *
 * «Остеопатия, приём Ирины» и «Остеопатия, прием Ирины» — одна и та же услуга,
 * набранная дважды разными руками. Ровно так справочник и задваивается.
 */
export function normalizeServiceTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Служебная позиция клиники: приём сотруднику, а не пациенту. */
function isStaffOnly(title: string): boolean {
  return /персонал/i.test(title);
}

/**
 * Разложить услуги без приёмов по причинам.
 *
 * Дублем считается строка, у которой есть тёзка С приёмами: работа записана
 * на неё, а эта висит пустой. Обратное неверно — две пустые строки с одним
 * названием дублями назвать нельзя, приёмов нет ни у одной.
 */
export function classifyIdleServices(rows: ServiceRowForIdle[]): IdleService[] {
  const busyTitles = new Set(
    rows.filter((r) => r.appointments > 0).map((r) => normalizeServiceTitle(r.title)),
  );

  return rows
    .filter((r) => r.appointments === 0)
    .map((r) => {
      const key = normalizeServiceTitle(r.title);
      const reason: IdleReason = busyTitles.has(key)
        ? "DUPLICATE"
        : isStaffOnly(r.title)
          ? "STAFF_ONLY"
          : r.price <= 1
            ? "NO_PRICE"
            : "NOT_ORDERED";
      return { title: r.title, reason };
    });
}
