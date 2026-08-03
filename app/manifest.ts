import type { MetadataRoute } from "next";

/**
 * PWA-манифест: платформа ставится на телефон как приложение (Добавить на
 * главный экран). Иконка — SVG (принимается современными браузерами).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Мера — CRM клиники",
    short_name: "Мера",
    description: "Инбокс, запись, аналитика и ИИ-ассистент клиники",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#4B44C7",
    lang: "ru",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
