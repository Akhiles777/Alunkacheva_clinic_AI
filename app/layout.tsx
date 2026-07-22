import type { Metadata } from "next";
import { Golos_Text, JetBrains_Mono, Manrope } from "next/font/google";
import "./globals.css";

// Display — гравированный шильдик, body — кириллический интерфейсный,
// данные — приборный моноширинный. См. DESIGN.md §3.
const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin", "cyrillic"],
  weight: ["500", "600", "700"],
});

const golos = Golos_Text({
  variable: "--font-golos",
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600"],
});

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Клиника — CRM",
  description: "Метрики клиники интегративной медицины",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ru"
      className={`${manrope.variable} ${golos.variable} ${jetbrains.variable} h-full`}
    >
      <body className="bg-panel text-engrave min-h-full">{children}</body>
    </html>
  );
}
