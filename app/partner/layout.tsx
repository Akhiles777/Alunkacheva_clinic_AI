import type { ReactNode } from "react";
import type { Metadata } from "next";

/**
 * Публичный отчёт школы-партнёра. Открыт без входа: школа пересылает ссылку в
 * общий чат. Поисковикам — нет (метатег и robots.txt): адрес секретный, и
 * в выдаче ему делать нечего.
 */
export const metadata: Metadata = {
  title: "Отчёт школы",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  referrer: "no-referrer",
};

export default function PartnerLayout({ children }: { children: ReactNode }) {
  return <div className="bg-raise text-text min-h-dvh">{children}</div>;
}
