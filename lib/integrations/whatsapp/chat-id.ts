import { normalizePhone } from "@/lib/phone";

/**
 * Преобразование адреса WhatsApp: chatId провайдера ↔ телефон в E.164.
 *
 * Green API адресует собеседника строкой вида `79991234567@c.us`. У нас
 * пациент опознаётся по телефону в E.164 (§4), и от точности этого перевода
 * зависит, к какой карточке привяжется переписка. Поэтому логика вынесена
 * отдельно и покрыта тестами: ошибка здесь молча приклеит диалог не тому
 * человеку.
 */

/** Личная переписка. Групповые чаты оканчиваются на @g.us. */
const PRIVATE_SUFFIX = "@c.us";
const GROUP_SUFFIX = "@g.us";

/**
 * Групповой чат или рассылка. Клиника с ними не работает: в группе нет одного
 * пациента, а ответ бота ушёл бы всем участникам.
 */
export function isGroupChat(chatId: string): boolean {
  return chatId.endsWith(GROUP_SUFFIX) || chatId.startsWith("status@");
}

/** Телефон в E.164 из chatId. null — не личная переписка или мусор. */
export function phoneFromChatId(chatId: string | null | undefined): string | null {
  if (!chatId || isGroupChat(chatId)) return null;
  const digits = chatId.split("@")[0]?.replace(/\D/g, "") ?? "";
  if (digits.length < 10) return null;
  // Green API отдаёт номер без плюса; normalizePhone приводит к E.164 и
  // заодно чинит российские номера, записанные через 8.
  return normalizePhone(`+${digits}`);
}

/**
 * chatId из телефона. Возвращает null, если номер не разобрать: отправлять по
 * непонятному адресу нельзя — сообщение уйдёт в никуда или чужому человеку.
 */
export function chatIdFromPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const e164 = normalizePhone(phone);
  if (!e164) return null;
  return `${e164.replace(/\D/g, "")}${PRIVATE_SUFFIX}`;
}
