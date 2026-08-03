"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const SECTIONS: { href: string; label: string }[] = [
  { href: "/settings/clinic", label: "Клиника" },
  { href: "/settings/rooms", label: "Кабинеты" },
  { href: "/settings/services", label: "Услуги" },
  { href: "/settings/staff", label: "Сотрудники" },
  { href: "/settings/sources", label: "Источники" },
  { href: "/settings/integrations", label: "Интеграции" },
  { href: "/settings/assistant", label: "Ассистент" },
  { href: "/settings/templates", label: "Шаблоны" },
  { href: "/settings/notifications", label: "Уведомления" },
  { href: "/settings/consent", label: "Согласие" },
  { href: "/settings/audit", label: "Аудит" },
];

/** Навигация по разделам настроек. Гейт по правам — в серверном layout. */
export function SettingsNav() {
  const pathname = usePathname();

  return (
    <nav className="border-border w-[196px] flex-none overflow-auto border-r px-3 py-4 max-md:hidden">
      <div className="text-text-subtle px-3 pb-2 text-2xs">Настройки</div>
      <div className="flex flex-col gap-0.5">
        {SECTIONS.map((s) => {
          const active = pathname === s.href;
          return (
            <Link
              key={s.href}
              href={s.href}
              aria-current={active ? "page" : undefined}
              className={`rounded-md px-3 py-1.5 text-sm ${
                active ? "bg-nav-active text-accent-text font-medium" : "text-text-muted hover:bg-hover"
              }`}
            >
              {s.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
