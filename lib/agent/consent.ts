import { prisma } from "@/lib/db";

/**
 * Согласие на обработку персональных данных в мессенджере (§7).
 *
 * Раздел настроек хранил текст и версию согласия, но спросить его было
 * некому: ни одной строки PatientConsent платформа не создавала никогда, а
 * агент про согласие не говорил ни слова. Для клиники, работающей с
 * медицинскими данными в России, это не косметика — 152-ФЗ требует
 * зафиксированного согласия до обработки.
 *
 * Спрашиваем один раз за диалог, при первом обращении. Карточки пациента в
 * этот момент может ещё не быть, поэтому факт живёт на диалоге и переносится
 * в PatientConsent, как только карточка появится.
 */

export const CONSENT_ACCEPT = "consent:yes";
export const CONSENT_DECLINE = "consent:no";

export interface ConsentRequest {
  text: string;
  buttons: { text: string; data: string }[];
}

/**
 * Нужно ли спросить согласие прямо сейчас. Возвращает готовое сообщение или
 * null, если спрашивать не нужно: согласие уже дано, вопрос уже задан или
 * клиника не завела текст согласия.
 */
export async function consentRequestFor(
  companyId: string,
  conversationId: string,
): Promise<ConsentRequest | null> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { consentAskedAt: true, consentGrantedAt: true },
  });
  if (!conv || conv.consentGrantedAt || conv.consentAskedAt) return null;

  const doc = await prisma.consentDocument.findFirst({
    where: { companyId, isActive: true },
    orderBy: { createdAt: "desc" },
    select: { policyUrl: true },
  });
  // Текст согласия не заведён — молчим. Показывать пустую ссылку хуже, чем не
  // спрашивать: администратор увидит пустой раздел в настройках и заполнит.
  if (!doc?.policyUrl) return null;

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { consentAskedAt: new Date() },
  });

  return {
    text:
      "Прежде чем продолжить: чтобы отвечать на вопросы и записывать вас на приём, " +
      "нам нужно ваше согласие на обработку персональных данных.\n" +
      `Политика: ${doc.policyUrl}`,
    buttons: [
      { text: "Согласен(на)", data: CONSENT_ACCEPT },
      { text: "Не сейчас", data: CONSENT_DECLINE },
    ],
  };
}

/**
 * Зафиксировать согласие. Если карточка пациента уже привязана — пишем строку
 * PatientConsent сразу, иначе она появится при привязке.
 */
export async function grantConsent(companyId: string, conversationId: string): Promise<void> {
  const now = new Date();
  const conv = await prisma.conversation.update({
    where: { id: conversationId },
    data: { consentGrantedAt: now },
    select: { patientId: true, channel: true },
  });
  if (conv.patientId) {
    await materializeConsent(companyId, conv.patientId, conversationId);
  }
}

/**
 * Перенести согласие с диалога в карточку пациента. Вызывается, когда карточка
 * появилась: до этого момента привязать согласие было не к кому.
 */
export async function materializeConsent(
  companyId: string,
  patientId: string,
  conversationId: string,
): Promise<void> {
  const [conv, doc] = await Promise.all([
    prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { consentGrantedAt: true, channel: true },
    }),
    prisma.consentDocument.findFirst({
      where: { companyId, isActive: true },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    }),
  ]);
  if (!conv?.consentGrantedAt || !doc) return;

  await prisma.patientConsent
    .upsert({
      where: { patientId_documentId: { patientId, documentId: doc.id } },
      update: {},
      create: {
        companyId,
        patientId,
        documentId: doc.id,
        grantedAt: conv.consentGrantedAt,
        channel: conv.channel,
      },
    })
    .catch(() => {});
}
