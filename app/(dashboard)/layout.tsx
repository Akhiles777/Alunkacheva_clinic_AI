import type { ReactNode } from "react";
import { Sidebar } from "./_components/sidebar";
import { CommandPalette } from "./_components/command-palette";
import { BookingPanel } from "./_components/booking-panel";

/**
 * Оболочка приложения: боковая навигация + рабочая область. Глобальный поиск
 * ⌘K смонтирован один раз здесь и доступен на всех экранах.
 */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen w-full overflow-hidden">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">{children}</main>
      <CommandPalette />
      <BookingPanel />
    </div>
  );
}
