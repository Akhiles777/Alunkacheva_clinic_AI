"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CallButton } from "./call-form";

/**
 * Боковая навигация (232px). Активный пункт — подложка nav-active + акцентный
 * текст. Метки — как в эталонном макете. Внизу профиль администратора.
 */
const NAV: { label: string; href: string; badge?: number }[] = [
  { label: "Сегодня", href: "/" },
  { label: "Диалоги", href: "/inbox", badge: 3 },
  { label: "Пациенты", href: "/patients" },
  { label: "Курсы", href: "/courses" },
  { label: "Кабинеты", href: "/schedule" },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="border-border bg-sidebar flex w-[232px] flex-none flex-col border-r px-4 py-5 max-md:hidden">
      <div className="px-2">
        <div className="text-lg leading-none font-medium tracking-[-0.015em]">Мера</div>
        <div className="text-text-subtle mt-1 text-2xs leading-tight">
          клиника интегративной медицины
        </div>
      </div>

      <nav className="mt-7 flex flex-col gap-0.5">
        {NAV.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center justify-between rounded-md px-3 py-2 text-sm ${
                active
                  ? "bg-nav-active text-accent-text font-medium"
                  : "text-text-muted hover:bg-hover"
              }`}
            >
              <span>{item.label}</span>
              {item.badge ? (
                <span className="num bg-chip-strong text-text-muted rounded-pill px-[7px] py-px text-2xs">
                  {item.badge}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className="flex-1" />

      <div className="mb-2">
        <CallButton className="w-full" />
      </div>

      <Link
        href="/settings"
        aria-current={isActive(pathname, "/settings") ? "page" : undefined}
        className={`mb-2 rounded-md px-3 py-2 text-sm ${
          isActive(pathname, "/settings")
            ? "bg-nav-active text-accent-text font-medium"
            : "text-text-muted hover:bg-hover"
        }`}
      >
        Настройки
      </Link>

      <div className="border-border-soft flex items-center gap-2.5 border-t px-2 py-2.5">
        <div className="bg-ink-avatar text-text-muted flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full text-2xs font-medium">
          ИД
        </div>
        <div className="min-w-0">
          <div className="text-xs font-medium">Ирина Долева</div>
          <div className="text-text-subtle text-2xs">администратор</div>
        </div>
      </div>
    </aside>
  );
}
