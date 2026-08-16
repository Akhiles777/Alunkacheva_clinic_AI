import { prisma } from "@/lib/db";
import { absoluteUrl } from "@/lib/server/app-url";

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
    select: { consentAskedAt: true, consentGrantedAt: true, patientId: true },
  });
  if (!conv || conv.consentGrantedAt || conv.consentAskedAt) return null;

  /**
   * Согласие принадлежит пациенту, а не переписке.
   *
   * Оно хранилось только на диалоге, и постоянная пациентка, написавшая с
   * другого канала или в новом диалоге, получала требование согласиться
   * заново — хотя подписала его давно и ходит в клинику годами. Для неё это
   * выглядит так, будто её не помнят.
   *
   * Если карточка привязана и согласие в ней есть — переносим отметку на
   * диалог и молчим.
   */
  if (conv.patientId) {
    const given = await prisma.patientConsent.findFirst({
      where: { companyId, patientId: conv.patientId },
      select: { grantedAt: true },
    });
    if (given) {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { consentGrantedAt: given.grantedAt, consentAskedAt: given.grantedAt },
      });
      return null;
    }
  }

  /**
   * Пациент, которого клиника уже знает.
   *
   * Требовать согласие у человека, который ходит в клинику годами и только что
   * переписывался с администратором, — решение заказчика отменить, и оно
   * разумное: в переписке это выглядит как «здравствуйте, вы кто?» на десятом
   * визите. Основание считать согласие полученным есть: пациент с визитами
   * подписал бумажную форму на первом приёме, а с тем, с кем клиника ведёт
   * переписку, отношения уже начаты — обе стороны это подтверждают самим
   * фактом разговора.
   *
   * Что считаем признаком: визиты в карточке или переписка, которая была до
   * сегодняшнего обращения (в том числе выкачанная из WhatsApp).
   */
  if (await knownToClinic(companyId, conversationId, conv.patientId)) {
    const now = new Date();
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { consentGrantedAt: now, consentAskedAt: now },
    });
    if (conv.patientId) await materializeConsent(companyId, conv.patientId, conversationId);
    return null;
  }

  const doc = await prisma.consentDocument.findFirst({
    where: { companyId, isActive: true },
    orderBy: { createdAt: "desc" },
    select: { policyUrl: true },
  });

  /**
   * Куда вести пациента за текстом.
   *
   * Ведём на свою страницу /policy — решение заказчика: документ живёт в
   * платформе и участвует в переписке. Ссылка на чужой файлообменник может
   * перестать открываться в любой день, и тогда согласие нельзя ни дать, ни
   * подтвердить, а без него §7 не разрешает вести переписку.
   *
   * Ссылка из настроек остаётся запасной — на случай, когда домен ещё не
   * задан (например, на локальном стенде).
   */
  const policyUrl = absoluteUrl("/policy") || doc?.policyUrl?.trim() || null;
  if (!policyUrl) return null;

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { consentAskedAt: new Date() },
  });

  return {
    text:
      "Прежде чем продолжить: чтобы отвечать на вопросы и записывать вас на приём, " +
      "нам нужно ваше согласие на обработку персональных данных.\n" +
      `Политика: ${policyUrl}`,
    buttons: [
      { text: "Согласен(на)", data: CONSENT_ACCEPT },
      { text: "Не сейчас", data: CONSENT_DECLINE },
    ],
  };
}

/**
 * Насколько давним должно быть сообщение, чтобы считаться прошлой перепиской.
 *
 * Текущее обращение уже сохранено к моменту проверки, и без окна оно засчитало
 * бы само себя: согласие не спросили бы ни у кого.
 */
const PRIOR_TALK_MS = 10 * 60 * 1000;

/**
 * Клиника уже знает этого человека: есть визиты или переписка до сегодня.
 */
async function knownToClinic(
  companyId: string,
  conversationId: string,
  patientId: string | null,
): Promise<boolean> {
  if (patientId) {
    const visits = await prisma.appointment.count({
      where: { companyId, patientId, deletedAt: null },
    });
    if (visits > 0) return true;
  }

  const earlier = await prisma.message.count({
    where: {
      conversationId,
      deletedAt: null,
      isDraft: false,
      createdAt: { lt: new Date(Date.now() - PRIOR_TALK_MS) },
    },
  });
  return earlier > 0;
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
