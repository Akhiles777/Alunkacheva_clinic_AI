import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Автономная сборка для контейнера: Next кладёт в .next/standalone сервер и
   * только те зависимости, которые действительно нужны. Образ выходит в разы
   * меньше, а на сервере не нужен ни npm install, ни node_modules целиком.
   */
  output: "standalone",
  // Значок dev-режима перекрывает профиль в сайдбаре и мешает скриншотам.
  devIndicators: false,
  experimental: {
    serverActions: {
      bodySizeLimit: "4mb",
    },
  },
};

export default nextConfig;
