"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { CallButton } from "./call-form";
import { logoutUser } from "@/app/(auth)/actions";
import { DOCTORS, ROLE_LABEL, setDoctor, setRole, useRole, type AppRole } from "@/app/_data/role";

/**
 * Боковая навигация (232px). Набор пунктов зависит от роли (личные кабинеты):
 * владелец видит «Владелец», врач — «Мой кабинет» и урезанный список. Внизу —
 * переключатель роли (демо, пока нет входа) и профиль.
 */
type NavItem = { label: string; href: string; badge?: number };

const NAV_COMMON: NavItem[] = [
  { label: "Сегодня", href: "/" },
  { label: "Чат", href: "/chat" },
  { label: "Диалоги", href: "/inbox", badge: 3 },
  { label: "Пациенты", href: "/patients" },
  { label: "Курсы", href: "/courses" },
  { label: "Кабинеты", href: "/schedule" },
  { label: "Отчёты", href: "/analytics" },
];

function navForRole(role: AppRole): NavItem[] {
  if (role === "owner") return [{ label: "Владелец", href: "/owner" }, ...NAV_COMMON];
  if (role === "doctor")
    return [
      { label: "Мой кабинет", href: "/doctor" },
      { label: "Чат", href: "/chat" },
      { label: "Диалоги", href: "/inbox", badge: 3 },
      { label: "Пациенты", href: "/patients" },
      { label: "Курсы", href: "/courses" },
    ];
  return NAV_COMMON;
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function initials(name: string): string {
  return name.split(/[\s.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("");
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { role, doctor } = useRole();
  const nav = navForRole(role);
  const showSettings = role !== "doctor";

  const profileName =
    role === "doctor" ? doctor.name : role === "owner" ? "Ольга Мерова" : "Ирина Долева";

  return (
    <aside className="border-border bg-sidebar flex w-[232px] flex-none flex-col border-r px-4 py-5 max-md:hidden">
      <div className="px-2">
        <div className="text-lg leading-none font-medium tracking-[-0.015em]">Мера</div>
        <div className="text-text-subtle mt-1 text-2xs leading-tight">
          клиника интегративной медицины
        </div>
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

      <div className="mb-2">
        <CallButton className="w-full" />
      </div>

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

      {/* Переключатель роли — демо, пока нет входа. */}
      <div className="border-border-soft mt-1 border-t pt-2.5">
        <div className="text-text-subtle mb-1.5 px-1 text-2xs">Роль (демо)</div>
        <div className="flex flex-col gap-1.5">
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as AppRole)}
            aria-label="Роль"
            className="border-border-input bg-surface w-full rounded-md border px-2.5 py-1.5 text-sm outline-none"
          >
            {(["owner", "admin", "doctor"] as AppRole[]).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
          {role === "doctor" ? (
            <select
              value={doctor.name}
              onChange={(e) => setDoctor(e.target.value)}
              aria-label="Врач"
              className="border-border-input bg-surface w-full rounded-md border px-2.5 py-1.5 text-sm outline-none"
            >
              {DOCTORS.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name} · {d.specialty}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      </div>

      <div className="border-border-soft mt-2 flex items-center gap-2.5 border-t px-2 pt-2.5">
        <div className="bg-ink-avatar text-text-muted flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full text-2xs font-medium">
          {initials(profileName)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{profileName}</div>
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
