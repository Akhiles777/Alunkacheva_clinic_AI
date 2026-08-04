"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { logoutUser } from "@/app/(auth)/actions";
import { CLINIC_NAME, CLINIC_TAGLINE } from "@/lib/brand";
import { ROLE_LABEL, type AppRole } from "@/lib/roles";
import { initials, isActive, navForRole } from "./nav-model";
import { NotificationCenter } from "./notification-center";

/**
 * Навигация для телефона: верхняя панель с кнопкой меню и выезжающая панель
 * разделов. До этого на мобильном не было навигации вообще — боковое меню
 * пряталось через max-md:hidden, и переходить между разделами было нечем,
 * кроме адресной строки.
 *
 * Панель занимает не весь экран, а левые 82%: видно, что это слой поверх
 * страницы, и её легко закрыть тапом по затемнению.
 */
export function MobileNav({
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
  const [open, setOpen] = useState(false);
  const nav = navForRole(role);
  // Переход закрывает панель: иначе она остаётся поверх новой страницы.
  const close = () => setOpen(false);

  // Пока панель открыта, страница под ней не должна прокручиваться.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // Закрытие по Escape — на планшете с клавиатурой это ожидаемо.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <header className="border-border bg-sidebar flex h-14 flex-none items-center gap-3 border-b px-4 md:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Открыть меню"
          aria-expanded={open}
          className="border-border text-text-muted hover:bg-hover flex h-10 w-10 flex-none items-center justify-center rounded-md border"
        >
          <span aria-hidden className="flex flex-col gap-[3px]">
            <span className="bg-text-muted block h-[2px] w-4 rounded-pill" />
            <span className="bg-text-muted block h-[2px] w-4 rounded-pill" />
            <span className="bg-text-muted block h-[2px] w-4 rounded-pill" />
          </span>
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm leading-tight font-medium">{CLINIC_NAME}</div>
          <div className="text-text-subtle truncate text-2xs leading-tight">
            {ROLE_LABEL[role].toLowerCase()} · {userName}
          </div>
        </div>
        <NotificationCenter />
      </header>

      {open ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <nav
            aria-label="Разделы"
            className="border-border bg-sidebar absolute inset-y-0 left-0 flex w-[82%] max-w-[320px] flex-col border-r"
          >
            <div className="border-border-soft flex items-start justify-between gap-3 border-b px-5 py-4">
              <div className="min-w-0">
                <div className="truncate text-base leading-tight font-medium">{CLINIC_NAME}</div>
                <div className="text-text-subtle truncate text-2xs">{CLINIC_TAGLINE}</div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Закрыть меню"
                className="text-text-subtle hover:text-text -mt-1 flex h-9 w-9 flex-none items-center justify-center text-xl"
              >
                ×
              </button>
            </div>

            <div className="flex-1 overflow-auto px-3 py-3">
              <div className="flex flex-col gap-0.5">
                {nav.map((item) => {
                  const active = isActive(pathname, item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={close}
                      aria-current={active ? "page" : undefined}
                      className={`flex items-center justify-between rounded-md px-3 py-3 text-[15px] ${
                        active ? "bg-nav-active text-accent-text font-medium" : "text-text-muted"
                      }`}
                    >
                      <span>{item.label}</span>
                      {item.badge ? (
                        <span className="num bg-chip-strong text-text-muted rounded-pill px-2 py-px text-2xs">
                          {item.badge}
                        </span>
                      ) : null}
                    </Link>
                  );
                })}
              </div>

              <div className="border-border-soft mt-3 flex flex-col gap-0.5 border-t pt-3">
                <Link
                  href="/help"
                  onClick={close}
                  aria-current={isActive(pathname, "/help") ? "page" : undefined}
                  className={`rounded-md px-3 py-3 text-[15px] ${
                    isActive(pathname, "/help")
                      ? "bg-nav-active text-accent-text font-medium"
                      : "text-text-muted"
                  }`}
                >
                  Справка
                </Link>
                {canEditSettings ? (
                  <Link
                    href="/settings"
                    onClick={close}
                    aria-current={isActive(pathname, "/settings") ? "page" : undefined}
                    className={`rounded-md px-3 py-3 text-[15px] ${
                      isActive(pathname, "/settings")
                        ? "bg-nav-active text-accent-text font-medium"
                        : "text-text-muted"
                    }`}
                  >
                    Настройки
                  </Link>
                ) : null}
              </div>
            </div>

            <div className="border-border-soft flex items-center gap-2.5 border-t px-5 py-4">
              <span className="bg-ink-avatar text-text-muted flex h-9 w-9 flex-none items-center justify-center rounded-full text-xs font-medium">
                {initials(userName) || "?"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{userName}</span>
                <span className="text-text-subtle block text-2xs">{ROLE_LABEL[role].toLowerCase()}</span>
              </span>
              <button
                type="button"
                onClick={async () => {
                  await logoutUser();
                  router.replace("/login");
                }}
                className="border-border text-text-muted flex-none rounded-md border px-3 py-2 text-xs"
              >
                Выйти
              </button>
            </div>
          </nav>
        </div>
      ) : null}
    </>
  );
}
