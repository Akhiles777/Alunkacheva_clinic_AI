/**
 * DTO YCLIENTS — минимальный набор полей, которые нам нужны для проекции.
 * Формы приблизительные (v2); уточним при подключении по реальным ответам.
 * Держим отдельно от наших моделей: маппинг — в mappers.ts.
 */
export interface YclientsService {
  id: number;
  title: string;
  /** Цена; в разных ответах бывает price_min/price. */
  price_min?: number;
  price?: number;
  /** Длительность сеанса в секундах. */
  seance_length?: number;
  category?: string;
  active?: number;
}

export interface YclientsStaff {
  id: number;
  name: string;
  specialization?: string;
  fired?: number;
}

export interface YclientsResource {
  id: number;
  title: string;
}

export interface YclientsClient {
  id: number;
  name?: string;
  phone?: string;
  /** Дата первого визита в YCLIENTS: «2023-11-09 12:00:00». */
  first_visit_date?: string | null;
}

export interface YclientsRecordService {
  id: number;
  title?: string;
  /** Итоговая стоимость услуги в записи — уже со скидкой. */
  cost?: number;
  /**
   * Цена до скидки и сама скидка.
   *
   * Без них ноль в `cost` неотличим от «администратор стоимость не проставил»,
   * и мы подставляли цену из прайса. Пациентке сделали скидку 100%, а в отчёте
   * у неё встало 3000 ₽. Разница видна именно здесь: при скидке цена до неё
   * известна, при незаполненной стоимости — нет.
   */
  first_cost?: number;
  discount?: number;
  amount?: number;
  cost_to_pay?: number;
}

export interface YclientsRecord {
  id: number;
  staff_id: number;
  /**
   * Специалист записи целиком.
   *
   * Нужен, когда его нет в справочнике: уволенных YCLIENTS в списке персонала
   * не отдаёт, а их прошлые визиты продолжает показывать. Без имени такой
   * визит приходилось выбрасывать — вместе с выручкой и занятым кабинетом.
   */
  staff?: { id?: number; name?: string; specialization?: string } | null;
  /**
   * Визит, к которому относится запись. У одного визита может быть несколько
   * записей (клиент попал к двум специалистам подряд) — по этому номеру видно,
   * что это один приход, а не два.
   */
  visit_id?: number;
  /** ISO datetime начала. */
  datetime: string;
  /** Длительность в секундах. */
  seance_length?: number;
  services?: YclientsRecordService[];
  client?: { id?: number; phone?: string; name?: string } | null;
  /** -1 не пришёл, 0 создана, 1 пришёл, 2 подтверждена. */
  visit_attendance?: number;
  /**
   * Когда запись создана в YCLIENTS. Метрика «записались» считается по ней
   * (§8), а не по дате визита: человек записывается в августе на сентябрь, и
   * для отдачи рекламы важен август.
   *
   * Имя поля у провайдера в разных версиях разное, поэтому читаем все три —
   * какое придёт, то и возьмём.
   */
  create_date?: string;
  created_at?: string;
  date_create?: string;
  /**
   * Оплата. Строкой — «paid_full», «paid_not_full», «not_paid»; числом —
   * 0/1/2 в старых версиях. Разбираем оба вида и храним сырое значение, чтобы
   * можно было проверить, а не поверить.
   */
  payment_status?: string | number;
  paid_full?: number;
  prepaid_confirmed?: boolean;
  deleted?: boolean;
  /** id ресурса (кабинета), если запись на ресурс. */
  resource_instances?: { resource_id: number }[];
}

/** Обёртка ответа YCLIENTS. */
export interface YclientsEnvelope<T> {
  success: boolean;
  data: T;
  meta?: { count?: number; total_count?: number };
}
