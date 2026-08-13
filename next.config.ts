import type { NextConfig } from "next";

function allowedOrigins(): string[] {
  const domain = process.env.DOMAIN?.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const list = ["localhost:3000", "localhost:3001"];
  if (domain) list.push(domain, `www.${domain}`);
  return list;
}

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
      /**
       * Домены, с которых принимаются server actions.
       *
       * Формы входа, сохранения настроек и ответа пациенту — это server
       * actions, то есть POST на тот же адрес. Next сверяет заголовок Origin
       * с тем, за какой домен он себя считает, и при расхождении отклоняет
       * запрос. За обратным прокси такое расхождение возникает легко: nginx
       * должен передать и Host, и X-Forwarded-Host, и X-Forwarded-Proto — а
       * забыть один заголовок нечего не стоит. Снаружи это выглядит так, что
       * страница открывается, но любая кнопка её ломает.
       *
       * Список задаётся переменной DOMAIN на этапе сборки.
       */
      allowedOrigins: allowedOrigins(),
    },
  },
};

export default nextConfig;
