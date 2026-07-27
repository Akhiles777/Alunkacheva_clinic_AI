"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { currentCan } from "@/app/_data/session";
import { NoAccess } from "./_components/ui";

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

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  // Гейт по праву EDIT_SETTINGS (§9). Реальная проверка — на сервере, позже.
  if (!currentCan("EDIT_SETTINGS")) {
    return <NoAccess />;
  }

  return (
    <div className="flex h-full min-h-0 flex-1">
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
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
