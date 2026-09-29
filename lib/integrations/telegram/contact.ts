/**
 * Номер из присланного контакта — только если это номер самого собеседника.
 *
 * В Telegram можно отправить ЛЮБОЙ контакт из записной книжки, а не только
 * свой. Прежде номер брался из любого: человек присылал контакт знакомой,
 * переписка привязывалась к её карточке, и на «когда у меня запись?» агент
 * называл её записи — врача, услугу, время. Это врачебная тайна (ст. 13
 * 323-ФЗ), и модель вдобавок получала историю чужой переписки.
 *
 * Кнопка «Отправить мой номер» присылает контакт, у которого user_id совпадает
 * с отправителем. Только такой номер и принимаем. Всё остальное — чужой номер
 * или контакт без user_id — отклоняем словами и просим нажать кнопку.
 */
export function ownContactPhone(input: {
  contact?: { phone_number: string; user_id?: number } | null;
  fromId?: number | null;
}): { phone: string } | { foreign: true } | null {
  if (!input.contact) return null;
  const { phone_number, user_id } = input.contact;
  if (typeof user_id !== "number" || typeof input.fromId !== "number" || user_id !== input.fromId) {
    return { foreign: true };
  }
  return { phone: phone_number };
}

/** Секрет вебхука — сравнение за постоянное время, как у WhatsApp. */
export function secretMatches(provided: string | null, expected: string): boolean {
  const got = provided ?? "";
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
