"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { CallButton } from "./call-form";
import { logoutUser } from "@/app/(auth)/actions";
import { ROLE_LABEL, type AppRole } from "@/lib/roles";
import { CLINIC_NAME, CLINIC_TAGLINE } from "@/lib/brand";
import { NotificationCenter } from "./notification-center";
import { initials, isActive, navForRole } from "./nav-model";

/**
 * Боковая навигация (232px) для десктопа. Набор пунктов берётся из общей
 * модели nav-model — той же, что у мобильного меню. На телефоне скрыта, там
 * работает MobileNav.
 */
export function Sidebar({
  role,
  userName,
  canEditSettings,
}: {
  role: AppRole;
  userName: string;
  canEditSettings: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const nav = navForRole(role);
  // Пункт показываем ровно тогда, когда сервер пропустит действие (матрица прав).
  const showSettings = canEditSettings;

  return (
    <aside className="border-border bg-sidebar flex w-[232px] flex-none flex-col border-r px-4 py-5 max-md:hidden">
      <div className="px-2">
        <div className="text-lg leading-none font-medium tracking-[-0.015em]">{CLINIC_NAME}</div>
        <div className="text-text-subtle mt-1 text-2xs leading-tight">{CLINIC_TAGLINE}</div>
      </div>

      <nav className="mt-7 flex flex-col gap-0.5">
        {nav.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center justify-between rounded-md px-3 py-2 text-sm ${
                active ? "bg-nav-active text-accent-text font-medium" : "text-text-muted hover:bg-hover"
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

      <div className="mb-2 flex items-center gap-2">
        <CallButton className="min-w-0 flex-1" />
        <NotificationCenter align="left" />
      </div>

      <Link
        href="/help"
        aria-current={isActive(pathname, "/help") ? "page" : undefined}
        className={`mb-2 rounded-md px-3 py-2 text-sm ${
          isActive(pathname, "/help")
            ? "bg-nav-active text-accent-text font-medium"
            : "text-text-muted hover:bg-hover"
        }`}
      >
        Справка
      </Link>

      {showSettings ? (
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
      ) : null}

      <div className="border-border-soft mt-1 flex items-center gap-2.5 border-t px-2 pt-2.5">
        <div className="bg-ink-avatar text-text-muted flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full text-2xs font-medium">
          {initials(userName) || "?"}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{userName}</div>
          <div className="text-text-subtle text-2xs">{ROLE_LABEL[role].toLowerCase()}</div>
        </div>
        <button
          type="button"
          onClick={async () => {
            await logoutUser();
            router.replace("/login");
          }}
          className="text-text-subtle hover:text-text flex-none text-2xs"
          title="Выйти"
        >
          Выйти
        </button>
      </div>
    </aside>
  );
}
