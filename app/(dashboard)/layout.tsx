import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { Sidebar } from "./_components/sidebar";
import { CommandPalette } from "./_components/command-palette";
import { BookingPanel } from "./_components/booking-panel";
import { CallForm } from "./_components/call-form";
import { StoreHydrator } from "./_components/store-hydrator";
import { AssistantChat } from "./_components/assistant-chat";
import { getSessionOrNull } from "@/lib/server/session";

/**
 * Оболочка приложения: боковая навигация + рабочая область. Вход защищён —
 * без сессии редиректим на /login. Глобальный поиск ⌘K смонтирован здесь.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await getSessionOrNull();
  if (!session) redirect("/login");

  return (
    <div className="flex h-screen w-full overflow-hidden">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">{children}</main>
      <CommandPalette />
      <BookingPanel />
      <CallForm />
      <AssistantChat />
      <StoreHydrator />
    </div>
  );
}
