/**
 * Что важно про пациента до того, как открыл переписку.
 *
 * Администратор смотрит на карточку три секунды, прежде чем начать отвечать.
 * За эти три секунды он должен узнать то, чего нет в телефоне: висит ли долг,
 * идёт ли курс и когда следующий сеанс, чем закончились прошлые записи и есть
 * ли служебные отметки. Ради этого он и откроет наш инбокс, даже если
 * сообщение пришло на телефон.
 *
 * Всё считается из уже загруженных данных карточки — своих, а не чужих. И
 * ничего не выдумывается: где наблюдений мало, строка не показывается вовсе.
 */

export interface GlanceVisit {
  status: "arrived" | "no_show" | "cancelled" | "planned";
  /** Машинная дата визита; без неё визит в счёт времени не идёт. */
  at?: string;
  amount: number;
  /** Деньги уже получены раньше — курс или абонемент. */
  paidEarlier?: boolean;
  service: string;
  doctor: string;
  kind?: "visit" | "purchase";
}

export interface GlanceCourse {
  title: string;
  used: number;
  total: number;
  booked?: number;
  status: "active" | "stalled" | "done";
}

export interface Glance {
  /** Ближайшая запись впереди. */
  next: { at: string; service: string; doctor: string } | null;
  /**
   * Неявки: сколько раз не пришёл из скольких состоявшихся или пропущенных.
   *
   * Это ФАКТ, а не прогноз. Модели предсказания неявки у нас нет, и рисовать
   * «риск 73%» без неё — выдавать догадку за расчёт. Факт при этом отвечает
   * на тот же вопрос администратора: подтверждать ли запись накануне.
   */
  noShow: { count: number; of: number } | null;
  /** Идущий курс: сколько пройдено и сколько записано вперёд. */
  course: { title: string; used: number; total: number; booked: number; stalled: boolean } | null;
  /**
   * Незакрытые деньги: состоявшиеся визиты с суммой, не помеченные
   * оплаченными. Строка появляется, только если клиника вообще отмечает
   * оплату (см. ниже) и такие визиты есть.
   */
  owes: { amount: number; visits: number } | null;
}

/** Сколько прошлых визитов нужно, чтобы говорить о неявках. */
export const MIN_VISITS_FOR_NOSHOW = 3;

export function glanceOf(
  visits: GlanceVisit[],
  courses: GlanceCourse[],
  now: Date = new Date(),
): Glance {
  const real = visits.filter((v) => v.kind !== "purchase");

  const upcoming = real
    .filter((v) => v.status === "planned" && v.at && new Date(v.at) > now)
    .sort((a, b) => new Date(a.at!).getTime() - new Date(b.at!).getTime())[0];

  const done = real.filter((v) => v.status === "arrived" || v.status === "no_show");
  const missed = done.filter((v) => v.status === "no_show").length;

  const active = courses.find((c) => c.status === "active" || c.status === "stalled");

  /**
   * Долг — самое опасное число в карточке, и потому самое осторожное.
   *
   * Отметку оплаты ставит YCLIENTS (`paid_full`), а ставят её там не всегда.
   * Если у пациента НИ ОДИН визит не помечен оплаченным, это значит «оплату
   * не отмечают», а не «не платил ни разу»: показать в таком случае «должен
   * 145 000 ₽» — отправить администратора требовать с человека деньги,
   * которые тот отдал. Поэтому строка появляется только там, где отметки
   * действительно ведут.
   *
   * Своего финучёта мы не ведём (§8): это повод спросить, а не счёт.
   */
  const paidKnown = real.some((v) => v.paidEarlier === true);
  const unpaid = paidKnown
    ? real.filter((v) => v.status === "arrived" && v.amount > 0 && v.paidEarlier !== true)
    : [];

  return {
    next: upcoming
      ? { at: upcoming.at!, service: upcoming.service, doctor: upcoming.doctor }
      : null,
    noShow: done.length >= MIN_VISITS_FOR_NOSHOW && missed > 0
      ? { count: missed, of: done.length }
      : null,
    course: active
      ? {
          title: active.title,
          used: active.used,
          total: active.total,
          booked: active.booked ?? 0,
          stalled: active.status === "stalled",
        }
      : null,
    owes: unpaid.length > 0
      ? { amount: unpaid.reduce((s, v) => s + v.amount, 0), visits: unpaid.length }
      : null,
  };
}
