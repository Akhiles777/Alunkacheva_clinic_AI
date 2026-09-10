import type { MetadataRoute } from "next";
import { CLINIC_NAME, CLINIC_SHORT_NAME } from "@/lib/brand";

/**
 * PWA-манифест: платформа ставится на телефон как приложение (Добавить на
 * главный экран).
 *
 * `any` и `maskable` — РАЗНЫЕ файлы, а не один под двумя ярлыками. Прежде
 * один и тот же значок числился и тем, и другим, и на телефоне он выглядел
 * маленьким: система обрезает маскируемую иконку по своей форме и ждёт, что
 * содержимое идёт до краёв. У нашей вокруг рисунка было прозрачное поле с
 * тенью — его-то система и обрезала, а рисунок оставался в середине.
 *
 * Поэтому у `maskable` фон до краёв и рисунок в безопасной зоне, а у `any`
 * рисунок занимает всё полотно и поля добавляет уже браузер.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${CLINIC_NAME} — CRM`,
    short_name: CLINIC_SHORT_NAME,
    description: "Инбокс, запись, аналитика и ИИ-ассистент клиники",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#4B44C7",
    lang: "ru",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-192-maskable.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
