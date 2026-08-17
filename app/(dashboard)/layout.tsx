import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { Sidebar } from "./_components/sidebar";
import { MobileNav } from "./_components/mobile-nav";
import { CommandPalette } from "./_components/command-palette";
import { BookingPanel } from "./_components/booking-panel";
import { CallForm } from "./_components/call-form";
import { StoreHydrator } from "./_components/store-hydrator";
import { WriteAlert } from "./_components/write-alert";
import { PushGate } from "./_components/push-gate";
import { StaleBuildGuard } from "./_components/stale-build-guard";
import { AssistantChat } from "./_components/assistant-chat";
import { getCurrentUser } from "./_components/user-actions";
import { getSessionOrNull } from "@/lib/server/session";

/**
 * Оболочка приложения: боковая навигация + рабочая область. Вход защищён —
 * без сессии редиректим на /login. Роль и имя берутся из сессии.
 *
 * Высота — 100dvh, а не 100vh: на телефоне vh считается по экрану без учёта
 * адресной строки, из-за чего низ страницы уезжал под неё.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await getSessionOrNull();
  if (!session) redirect("/login");
  const user = await getCurrentUser();

  return (
    <div className="flex h-dvh w-full overflow-hidden max-md:flex-col">
      <MobileNav role={user.role} userName={user.name} canEditSettings={user.canEditSettings} />
      <Sidebar role={user.role} userName={user.name} canEditSettings={user.canEditSettings} />
      {/* Запас снизу — «безопасная зона» под плавающими кнопками ассистента и
          уведомлений. Без него они перекрывали кнопку отправки в чате и в
          инбоксе, причём на десктопе тоже, а не только на телефоне. */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col pb-16">{children}</main>
      <CommandPalette />
      <BookingPanel />
      <CallForm />
      <AssistantChat />
      <StoreHydrator />
      <WriteAlert />
      <PushGate />
      <StaleBuildGuard />
    </div>
  );
}
