/**
 * Мок пациентов для поиска, списка и карточки. Визуальный слой.
 * Форма — под будущий `GET /api/patients`. Телефоны в E.164.
 */
export interface CourseProgress {
  id: string;
  title: string;
  used: number;
  total: number;
  status: "active" | "stalled" | "done";
  lastVisit: string;
}

export interface VisitRow {
  id: string;
  date: string;
  service: string;
  doctor: string;
  status: "arrived" | "no_show" | "cancelled" | "planned";
  amount: number;
}

export interface PatientMessage {
  id: string;
  from: "patient" | "staff" | "bot";
  text: string;
  at: string;
}

export interface Patient {
  id: string;
  name: string;
  phone: string; // E.164
  phonePretty: string;
  bornYear: number | null;
  firstSeen: string;
  source: string;
  channel: "instagram" | "whatsapp" | "phone" | "offline";
  tags: string[];
  courses: CourseProgress[];
  visits: VisitRow[];
  messages: PatientMessage[];
}

export const PATIENTS: Patient[] = [
  {
    id: "p-grinberg",
    name: "Гринберг Ирина Львовна",
    phone: "+79161234567",
    phonePretty: "+7 916 123-45-67",
    bornYear: 1984,
    firstSeen: "12 марта 2026",
    source: "Instagram",
    channel: "instagram",
    tags: ["на курсе"],
    courses: [
      { id: "c1", title: "IV-терапия, капельница", used: 6, total: 10, status: "active", lastVisit: "сегодня" },
    ],
    visits: [
      { id: "v1", date: "23 июля", service: "IV-терапия, капельница", doctor: "Соколова Е.", status: "arrived", amount: 6500 },
      { id: "v2", date: "16 июля", service: "IV-терапия, капельница", doctor: "Соколова Е.", status: "arrived", amount: 6500 },
      { id: "v3", date: "9 июля", service: "IV-терапия, капельница", doctor: "Соколова Е.", status: "arrived", amount: 6500 },
      { id: "v4", date: "2 июля", service: "Первичный приём", doctor: "Соколова Е.", status: "arrived", amount: 3500 },
    ],
    messages: [
      { id: "m1", from: "patient", text: "Здравствуйте, а капельница сегодня во сколько?", at: "10:30" },
      { id: "m2", from: "bot", text: "Здравствуйте! Вы записаны на 11:00 в кабинет 2.", at: "10:31" },
      { id: "m3", from: "patient", text: "А есть побочные эффекты от этого состава?", at: "10:38" },
    ],
  },
  {
    id: "p-belov",
    name: "Белов Лев Кириллович",
    phone: "+79031112233",
    phonePretty: "+7 903 111-22-33",
    bornYear: 1991,
    firstSeen: "сегодня",
    source: "WhatsApp",
    channel: "whatsapp",
    tags: ["первичный"],
    courses: [],
    visits: [
      { id: "v1", date: "23 июля", service: "Остеопатия, приём", doctor: "Левин А.", status: "arrived", amount: 4200 },
    ],
    messages: [
      { id: "m1", from: "patient", text: "Спасибо, всё подошло. Можно записаться ещё раз?", at: "10:18" },
    ],
  },
  {
    id: "p-sedyh",
    name: "Седых Дмитрий Петрович",
    phone: "+79267778899",
    phonePretty: "+7 926 777-88-99",
    bornYear: 1978,
    firstSeen: "4 апреля 2026",
    source: "Рекомендация",
    channel: "phone",
    tags: ["выпал из курса"],
    courses: [
      { id: "c1", title: "Остеопатия, курс", used: 4, total: 10, status: "stalled", lastVisit: "18 дней назад" },
    ],
    visits: [
      { id: "v1", date: "5 июля", service: "Остеопатия, коррекция", doctor: "Левин А.", status: "arrived", amount: 4200 },
      { id: "v2", date: "28 июня", service: "Остеопатия, коррекция", doctor: "Левин А.", status: "arrived", amount: 4200 },
    ],
    messages: [],
  },
  {
    id: "p-konstantinopolskaya",
    name: "Константинопольская-Ржевская Аполлинария Владиславовна",
    phone: "+79995554433",
    phonePretty: "+7 999 555-44-33",
    bornYear: 1965,
    firstSeen: "сегодня",
    source: "Сайт",
    channel: "instagram",
    tags: ["первичный"],
    courses: [],
    visits: [
      { id: "v1", date: "23 июля", service: "Остеопатия, приём", doctor: "Левин А.", status: "planned", amount: 0 },
    ],
    messages: [],
  },
  {
    id: "p-chernysheva",
    name: "Чернышёва Жанна Захаровна",
    phone: "+79104443322",
    phonePretty: "+7 910 444-33-22",
    bornYear: 1996,
    firstSeen: "20 июня 2026",
    source: "Instagram",
    channel: "whatsapp",
    tags: ["на курсе"],
    courses: [
      { id: "c1", title: "БОС-терапия, курс", used: 1, total: 8, status: "active", lastVisit: "3 дня назад" },
    ],
    visits: [
      { id: "v1", date: "20 июля", service: "БОС-терапия, сеанс", doctor: "Мороз Д.", status: "arrived", amount: 5000 },
    ],
    messages: [
      { id: "m1", from: "patient", text: "Можно перенести завтрашний сеанс на вечер?", at: "10:40" },
    ],
  },
];

export function findPatient(id: string): Patient | undefined {
  return PATIENTS.find((p) => p.id === id);
}

/** Поиск по имени или цифрам телефона. */
export function searchPatients(query: string): Patient[] {
  const q = query.trim().toLowerCase();
  if (!q) return PATIENTS;
  const digits = q.replace(/\D/g, "");
  return PATIENTS.filter((p) => {
    const nameHit = p.name.toLowerCase().includes(q);
    const phoneHit = digits.length >= 2 && p.phone.replace(/\D/g, "").includes(digits);
    return nameHit || phoneHit;
  });
}
