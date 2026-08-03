import { getCurrentUser } from "../_components/user-actions";
import { ROLE_LABEL, type AppRole } from "@/lib/roles";

export const metadata = { title: "Справка — Мера" };

interface Section {
  role: AppRole | "all";
  icon: string;
  title: string;
  intro: string;
  items: { h: string; t: string }[];
}

const SECTIONS: Section[] = [
  {
    role: "all",
    icon: "✦",
    title: "О платформе",
    intro: "«Мера» — надстройка над YCLIENTS: единый инбокс, ИИ-ассистент, запись, аналитика. Данные о расписании и выручке приходят из YCLIENTS, платформа их показывает и анализирует.",
    items: [
      { h: "Вход", t: "Каждый сотрудник входит по своей почте и паролю. Владелец может войти без регистрации кнопкой «Войти как владелец»." },
      { h: "Роли", t: "Владелец, Администратор, Врач — у каждой свой кабинет и набор возможностей. Роль задаётся учётной записью." },
      { h: "ИИ-ассистент", t: "Плашка «Спросить ИИ» есть на всех страницах: спросите про пациента, запись, курсы — ответит по вашим данным." },
      { h: "Установка на телефон", t: "Откройте платформу в браузере телефона → «Добавить на главный экран». Работает как приложение, приходят уведомления." },
    ],
  },
  {
    role: "owner",
    icon: "👑",
    title: "Владелец",
    intro: "Полная картина клиники и личный ИИ-аналитик.",
    items: [
      { h: "Полный отчёт", t: "Выручка, средний чек, приёмы, загрузка кабинетов, производительность и часы каждого сотрудника, разрез выручки по услугам." },
      { h: "Динамика по неделям", t: "Графики дохода и клиентов за 6 недель с ростом «последняя vs первая неделя»." },
      { h: "ИИ-аналитик голосом", t: "Зажмите микрофон и спросите, или нажмите «Позвонить» — ассистент проведёт глубокий анализ и ответит живым голосом, помнит диалог." },
      { h: "Сотрудники и цены", t: "В «Настройках» добавляйте сотрудников с логином/паролем, задавайте цены услуг, права ролей." },
    ],
  },
  {
    role: "admin",
    icon: "🗂",
    title: "Администратор",
    intro: "Ежедневная работа: обращения, записи, пациенты.",
    items: [
      { h: "Сегодня", t: "Кабинеты в реальном времени, свободные окна, что требует внимания, новые обращения." },
      { h: "Диалоги", t: "Переписка из Instagram и WhatsApp в одном окне, шаблоны вне 24-часового окна." },
      { h: "Запись и звонок", t: "«+ Запись» — свободное окно, услуга, цена (по умолчанию из настроек), поле «Дополнительно». «Занести звонок» — обращение с привязкой к пациенту по номеру." },
      { h: "Пациенты", t: "Карточка с телефонами, отметками, связями, курсами и историей визитов; поиск по имени и номеру." },
    ],
  },
  {
    role: "doctor",
    icon: "🩺",
    title: "Врач",
    intro: "Свой кабинет, расписание и общение с командой.",
    items: [
      { h: "Мой кабинет", t: "Расписание только ваших приёмов, уведомления (ближайший приём, первичные, неявки), ваша статистика за день." },
      { h: "Чат сотрудников", t: "Общий канал и личные диалоги с каждым коллегой: текст, голосовые, удаление своих сообщений, вложение карточки пациента и курса." },
      { h: "Пациенты и курсы", t: "Доступ к карточкам пациентов и курсам для подготовки к приёму." },
    ],
  },
];

function roleName(r: AppRole | "all"): string {
  return r === "all" ? "Всем" : ROLE_LABEL[r];
}

export default async function HelpPage() {
  const user = await getCurrentUser();

  return (
    <>
      <header className="border-border flex-none border-b px-7 py-[18px] max-md:px-5">
        <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">Справка</h1>
        <p className="text-text-muted mt-1 text-xs">
          Как пользоваться платформой. Ваша роль — {ROLE_LABEL[user.role].toLowerCase()}.
        </p>
      </header>

      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <div className="grid max-w-[900px] grid-cols-1 gap-4 lg:grid-cols-2">
          {SECTIONS.map((s) => {
            const mine = s.role === user.role;
            return (
              <section
                key={s.title}
                className={`rounded-xl border p-5 ${mine ? "border-accent-border bg-accent-tint" : "border-border bg-surface"}`}
              >
                <div className="mb-3 flex items-center gap-2.5">
                  <span aria-hidden className="text-lg leading-none">{s.icon}</span>
                  <h2 className="text-base font-medium">{s.title}</h2>
                  <span className="text-text-subtle ml-auto text-2xs">{roleName(s.role)}</span>
                </div>
                <p className="text-text-muted mb-3 text-sm leading-snug">{s.intro}</p>
                <ul className="flex flex-col gap-2.5">
                  {s.items.map((it) => (
                    <li key={it.h}>
                      <div className="text-sm font-medium">{it.h}</div>
                      <div className="text-text-muted text-sm leading-snug">{it.t}</div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </>
  );
}
