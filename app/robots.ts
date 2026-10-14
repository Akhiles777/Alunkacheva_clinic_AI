import type { MetadataRoute } from "next";

/**
 * Отчёты школ открываются без входа по секретной ссылке (`/partner/…`), и в
 * поисковой выдаче им не место. Страница сама просит не индексировать
 * (метатег), robots.txt говорит то же заранее.
 */
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", disallow: ["/partner/"] }] };
}
