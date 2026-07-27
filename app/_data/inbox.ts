/**
 * Мок «Диалогов» — визуальный слой, форма под будущий `GET /api/conversations`.
 */
export type DialogChannel = "instagram" | "whatsapp";
export type DialogStatus = "bot" | "escalated" | "human" | "closed";

export interface DialogMessage {
  id: string;
  from: "patient" | "staff" | "bot";
  text: string;
  at: string;
}

export interface Dialog {
  id: string;
  name: string;
  channel: DialogChannel;
  /** id из app/_data/patients, если пациент опознан по телефону. */
  patientId: string | null;
  status: DialogStatus;
  preview: string;
  at: string;
  unread: boolean;
  /** Причина эскалации — для статуса escalated. */
  escalationReason?: string;
  /** Черновик агента на подтверждение — suggest-режим. */
  agentDraft?: string;
  messages: DialogMessage[];
}

export const DIALOGS: Dialog[] = [
  {
    id: "d-grinberg",
    name: "Гринберг Ирина Львовна",
    channel: "instagram",
    patientId: "p-grinberg",
    status: "escalated",
    preview: "А есть побочные эффекты от этого состава?",
    at: "10:38",
    unread: true,
    escalationReason: "медицинский вопрос",
    messages: [
      { id: "m1", from: "patient", text: "Здравствуйте, а капельница сегодня во сколько?", at: "10:30" },
      { id: "m2", from: "bot", text: "Здравствуйте! Вы записаны на 11:00 в кабинет 2.", at: "10:31" },
      { id: "m3", from: "patient", text: "А есть побочные эффекты от этого состава?", at: "10:38" },
    ],
  },
  {
    id: "d-chernysheva",
    name: "Чернышёва Жанна Захаровна",
    channel: "whatsapp",
    patientId: "p-chernysheva",
    status: "human",
    preview: "Можно перенести завтрашний сеанс на вечер?",
    at: "10:40",
    unread: true,
    agentDraft:
      "Здравствуйте! Да, на завтра есть свободное окно в 18:30 в кабинете 3. Перенести ваш сеанс на это время?",
    messages: [
      { id: "m1", from: "patient", text: "Можно перенести завтрашний сеанс на вечер?", at: "10:40" },
    ],
  },
  {
    id: "d-newiv",
    name: "Новый номер +7 916 320-14-08",
    channel: "instagram",
    patientId: null,
    status: "bot",
    preview: "Здравствуйте! Сколько стоит курс капельниц?",
    at: "10:42",
    unread: true,
    messages: [
      { id: "m1", from: "patient", text: "Здравствуйте! Сколько стоит курс капельниц?", at: "10:42" },
      { id: "m2", from: "bot", text: "Здравствуйте! Курс IV-терапии из 10 капельниц — 65 000 ₽. Рассказать подробнее или записать на первую?", at: "10:42" },
    ],
  },
  {
    id: "d-belov",
    name: "Белов Лев Кириллович",
    channel: "whatsapp",
    patientId: "p-belov",
    status: "bot",
    preview: "Спасибо, всё подошло. Можно записаться ещё раз?",
    at: "10:18",
    unread: false,
    messages: [
      { id: "m1", from: "patient", text: "Спасибо, всё подошло. Можно записаться ещё раз?", at: "10:18" },
      { id: "m2", from: "bot", text: "Рады помочь! На какое направление вас записать?", at: "10:18" },
    ],
  },
  {
    id: "d-newost",
    name: "Новый номер +7 903 771-52-30",
    channel: "whatsapp",
    patientId: null,
    status: "closed",
    preview: "А остеопат принимает детей?",
    at: "09:55",
    unread: false,
    messages: [
      { id: "m1", from: "patient", text: "А остеопат принимает детей?", at: "09:55" },
      { id: "m2", from: "bot", text: "Да, принимает с 6 лет. Записать на консультацию?", at: "09:55" },
      { id: "m3", from: "patient", text: "Спасибо, я подумаю", at: "09:56" },
    ],
  },
];

export const DIALOG_FILTERS = [
  { id: "need", label: "Нужен ответ" },
  { id: "escalated", label: "Эскалации" },
  { id: "drafts", label: "Черновики агента" },
  { id: "all", label: "Все" },
  { id: "closed", label: "Закрытые" },
] as const;

export function dialogMatchesFilter(d: Dialog, filter: string): boolean {
  switch (filter) {
    case "need":
      return d.unread && d.status !== "closed";
    case "escalated":
      return d.status === "escalated";
    case "drafts":
      return Boolean(d.agentDraft);
    case "closed":
      return d.status === "closed";
    default:
      return true;
  }
}

export const DIALOG_STATUS_LABEL: Record<DialogStatus, string> = {
  bot: "ведёт агент",
  escalated: "нужен человек",
  human: "ведёт человек",
  closed: "закрыт",
};

export const CHANNEL_LABEL: Record<DialogChannel, string> = {
  instagram: "Instagram",
  whatsapp: "WhatsApp",
};
