import { CLINIC_MAIL_DOMAIN } from "../brand";

/**
 * Контакт отправителя для служб push. Это должен быть mailto: или https://, и
 * ничего больше: службы push по нему связываются с владельцем ключа.
 *
 * Значение из окружения проверяем, а не берём на веру. На боевом стенде в эту
 * переменную попал открытый ключ вместо адреса — библиотека отказывалась
 * настраиваться, и не уходил ни один push, включая проверочный. Отправка
 * уведомлений не должна зависеть от того, что кто-то перепутал поля: неверное
 * значение игнорируем и работаем с адресом по умолчанию.
 */
export function vapidSubject(): string {
  const fallback = `mailto:admin@${CLINIC_MAIL_DOMAIN}`;
  const raw = process.env.VAPID_SUBJECT?.trim();
  if (!raw) return fallback;
  if (/^mailto:\S+@\S+\.\S+$/i.test(raw)) return raw;
  if (/^https:\/\/\S+\.\S+/i.test(raw)) return raw;
  return fallback;
}
