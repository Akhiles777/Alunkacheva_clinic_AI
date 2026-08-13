import type { ReactNode } from "react";
import { CLINIC_NAME } from "@/lib/brand";

/**
 * Публичный раздел с юридическими документами.
 *
 * Открыт без входа намеренно: ссылку на него получает пациент в мессенджере
 * при первом обращении, до того как у него появится хоть какая-то учётная
 * запись. Согласие, которое нельзя прочитать, согласием не является.
 */
export default function PolicyLayout({ children }: { children: ReactNode }) {
  return (
    <div className="bg-surface min-h-dvh">
      <header className="border-border bg-raise border-b px-5 py-4">
        <div className="mx-auto max-w-[760px]">
          <span className="text-text text-sm font-medium">{CLINIC_NAME}</span>
        </div>
      </header>
      <main className="mx-auto max-w-[760px] px-5 py-8 pb-16">{children}</main>
    </div>
  );
}
