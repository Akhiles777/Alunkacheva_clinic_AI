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
  cost?: number;
}

export interface YclientsRecord {
  id: number;
  staff_id: number;
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
