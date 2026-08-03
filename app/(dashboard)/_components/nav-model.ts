import type { AppRole } from "@/lib/roles";

/**
 * Модель навигации — одна на десктоп и на телефон. Держим отдельно, чтобы
 * мобильное меню не разъезжалось с боковым: раньше набор пунктов жил только в
 * сайдбаре, а сайдбар на телефоне просто прятался, и переходить между
 * разделами было нечем.
 */
export type NavItem = { label: string; href: string; badge?: number };

// «Чат» доступен всем ролям: это внутренняя переписка клиники, а не
// пациентский канал.
const NAV_COMMON: NavItem[] = [
  { label: "Сегодня", href: "/" },
  { label: "Диалоги", href: "/inbox", badge: 3 },
  { label: "Чат", href: "/chat" },
  { label: "Пациенты", href: "/patients" },
  { label: "Курсы", href: "/courses" },
  { label: "Кабинеты", href: "/schedule" },
  { label: "Отчёты", href: "/analytics" },
];

export function navForRole(role: AppRole): NavItem[] {
  if (role === "owner") return [{ label: "Владелец", href: "/owner" }, ...NAV_COMMON];
  if (role === "doctor")
    return [
      { label: "Мой кабинет", href: "/doctor" },
      { label: "Диалоги", href: "/inbox", badge: 3 },
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
