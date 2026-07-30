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
