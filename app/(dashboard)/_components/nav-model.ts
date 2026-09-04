import type { AppRole } from "@/lib/roles";

/**
 * Модель навигации — одна на десктоп и на телефон. Держим отдельно, чтобы
 * мобильное меню не разъезжалось с боковым: раньше набор пунктов жил только в
 * сайдбаре, а сайдбар на телефоне просто прятался, и переходить между
 * разделами было нечем.
 */
export type NavItem = { label: string; href: string; badge?: number };

/**
 * Счётчик у «Диалогов».
 *
 * Здесь стояла жёстко вписанная тройка. Она не менялась никогда: сколько бы
 * обращений ни ждало ответа, в меню всегда светилось «3». Такой значок хуже,
 * чем никакого, — на него перестают смотреть.
 *
 * Считаем то, ради чего он нужен: диалоги, где последним написал пациент и
 * которые ещё не закрыты.
 */
export function waitingCount(dialogs: { unread: boolean; status: string }[]): number {
  return dialogs.filter((d) => d.unread && d.status !== "closed").length;
}

// «Чат» доступен всем ролям: это внутренняя переписка клиники, а не
// пациентский канал.
const NAV_COMMON: NavItem[] = [
  { label: "Сегодня", href: "/" },
  { label: "Диалоги", href: "/inbox" },
  { label: "Чат", href: "/chat" },
  { label: "Пациенты", href: "/patients" },
  { label: "Курсы", href: "/courses" },
  // Рабочая очередь администратора: кому звонить и что предложить.
  { label: "Кому позвонить", href: "/queue" },
  { label: "Кабинеты", href: "/schedule" },
  { label: "Отчёты", href: "/analytics" },
];

export function navForRole(role: AppRole): NavItem[] {
  if (role === "owner") return [{ label: "Владелец", href: "/owner" }, ...NAV_COMMON];
  if (role === "doctor")
    return [
      { label: "Мой кабинет", href: "/doctor" },
      { label: "Диалоги", href: "/inbox" },
      { label: "Чат", href: "/chat" },
      { label: "Пациенты", href: "/patients" },
      { label: "Курсы", href: "/courses" },
    ];
  return NAV_COMMON;
}

export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function initials(name: string): string {
  return name.split(/[\s.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("");
}
