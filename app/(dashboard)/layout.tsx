import type { ReactNode } from "react";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-[1360px] px-4 py-4 md:px-6 md:py-6">
      <div className="border-groove border">
        <header className="border-groove flex items-center gap-4 border-b px-4 py-2">
          <span className="display text-[13px] font-bold tracking-[0.06em] uppercase">
            Клиника
          </span>
          <nav aria-label="Разделы" className="legend flex gap-3">
            <span aria-current="page" className="text-engrave">
              Метрики
            </span>
            {/* Инбокс — этап 2, ссылку ставим, когда он появится. */}
            <span className="opacity-55">Инбокс</span>
          </nav>
        </header>
        {children}
      </div>
    </div>
  );
}
