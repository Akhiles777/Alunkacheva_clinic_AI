import type { Metadata } from "next";
import { JetBrains_Mono, Onest } from "next/font/google";
import "./globals.css";

// Один шрифт на интерфейс — Onest: кириллица в основе, спокойный, но не
// нейтральный до безликости. Моноширинный — только под числа и время.
const onest = Onest({
  variable: "--font-onest",
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600"],
});

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Мера",
  description: "CRM клиники интегративной медицины «Мера»",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" className={`${onest.variable} ${jetbrains.variable} h-full`}>
      <body className="bg-bg text-text min-h-full">{children}</body>
    </html>
  );
}
