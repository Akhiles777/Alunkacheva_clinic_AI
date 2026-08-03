import type { ReactNode } from "react";
import { CLINIC_NAME, CLINIC_TAGLINE } from "@/lib/brand";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="bg-bg flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-6 text-center">
          <div className="text-lg font-medium tracking-[-0.015em]">{CLINIC_NAME}</div>
          <div className="text-text-subtle text-xs">{CLINIC_TAGLINE}</div>
        </div>
        {children}
      </div>
    </div>
  );
}
