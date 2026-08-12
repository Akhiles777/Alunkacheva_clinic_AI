import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Значок dev-режима перекрывает профиль в сайдбаре и мешает скриншотам.
  devIndicators: false,
  experimental: {
    serverActions: {
      bodySizeLimit: "4mb",
    },
  },
};

export default nextConfig;
