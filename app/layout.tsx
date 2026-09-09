import type { Metadata, Viewport } from "next";
import { CLINIC_NAME, CLINIC_TAGLINE } from "@/lib/brand";
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
  title: { default: CLINIC_NAME, template: `%s — ${CLINIC_NAME}` },
  description: `CRM: ${CLINIC_TAGLINE} «${CLINIC_NAME}»`,
  /**
   * Иконки называем явно.
   *
   * Значок не появлялся ни во вкладке, ни на телефоне, и причина была простая:
   * `favicon.ico` лежал в корне репозитория, откуда Next его не отдаёт — он
   * ищет `app/favicon.ico` либо `public/`. Файл был на месте, ссылки на него
   * не было ни одной. iOS до манифеста не читает вовсе: домашнему экрану нужен
   * apple-touch-icon, иначе там окажется снимок страницы.
   */
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
};

/**
 * Экран на телефоне не «прыгает» при вводе.
 *
 * Корневая причина приближения — Safari на iOS увеличивает страницу, когда
 * шрифт поля меньше 16px (это решается в globals.css). Здесь дополнительно
 * фиксируем масштаб, как просил заказчик, и просим браузер при появлении
 * клавиатуры сжимать содержимое, а не наезжать на него.
 *
 * Плата за maximumScale: щипком страницу больше не увеличить. Если понадобится
 * вернуть — достаточно убрать maximumScale и userScalable, вёрстка от этого
 * не пострадает.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#4B44C7",
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
