import type { ReactNode } from "react";
import { getSession } from "@/lib/server/session";
import { can } from "@/lib/server/authz";
import { NoAccess } from "./_components/ui";
import { SettingsNav } from "./settings-nav";

/**
 * Гейт по праву EDIT_SETTINGS (§9) — серверный, по той же матрице прав, которую
 * проверяют server actions. Раньше здесь стоял клиентский мок сессии с
 * захардкоженной ролью OWNER: гейт пропускал кого угодно, а сохранение потом
 * падало с «Недостаточно прав». Один источник правды — матрица в БД.
 */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!(await can(session, "EDIT_SETTINGS"))) {
    return <NoAccess />;
  }

  return (
    <div className="flex h-full min-h-0 flex-1">
      <SettingsNav />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
