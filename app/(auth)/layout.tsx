import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="bg-bg flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-6 text-center">
          <div className="text-lg font-medium tracking-[-0.015em]">Мера</div>
          <div className="text-text-subtle text-xs">клиника интегративной медицины</div>
        </div>
        {children}
      </div>
    </div>
  );
}
