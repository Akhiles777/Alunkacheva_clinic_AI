"use client";

import { useEffect, useRef } from "react";
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

/**
 * Навигация по разделам настроек. Гейт по правам — в серверном layout.
 *
 * На телефоне это горизонтальная лента вкладок, а не боковой список: раньше
 * колонка просто пряталась через max-md:hidden, и с телефона был доступен
 * ровно один раздел — тот, на который увели по ссылке. Остальные десять
 * открыть было нечем.
 */
export function SettingsNav() {
  const pathname = usePathname();
  const stripRef = useRef<HTMLDivElement | null>(null);

  // Активную вкладку подкручиваем в зону видимости: на узком экране она
  // запросто оказывается за краем ленты.
  useEffect(() => {
    const strip = stripRef.current;
    const active = strip?.querySelector('[aria-current="page"]');
    active?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [pathname]);

  return (
    <>
      {/* Телефон: лента вкладок с горизонтальной прокруткой. */}
      <div
        ref={stripRef}
        className="border-border bg-surface -mx-px flex flex-none gap-1 overflow-x-auto border-b px-3 py-2 md:hidden"
      >
        {SECTIONS.map((s) => {
          const active = pathname === s.href;
          return (
            <Link
              key={s.href}
              href={s.href}
              aria-current={active ? "page" : undefined}
              className={`flex-none rounded-md px-3 py-2 text-sm whitespace-nowrap ${
                active ? "bg-nav-active text-accent-text font-medium" : "text-text-muted"
              }`}
            >
              {s.label}
            </Link>
          );
        })}
      </div>

      {/* Десктоп: боковая колонка. */}
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
    </>
  );
}
