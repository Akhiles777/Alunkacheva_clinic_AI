import { after, type NextRequest } from "next/server";
import { isPreviewBot } from "@/lib/metrics/promo-marker";
import { notePromoLinkClick, promoLinkTarget } from "@/lib/server/promos";

/**
 * Короткая ссылка школьной акции: alunkachevaclinic.ru/children → WhatsApp
 * клиники с готовым текстом «Здравствуйте! Хочу записать ребёнка на школьный
 * ресурс».
 *
 * Ссылка wa.me с текстом длинная и с кодировкой — на листовке и в чате школы
 * её не напечатать и не набрать (заказчик, 20 октября). Куда вести, решают
 * настройки акции на экране: номер и метка правятся там, а напечатанный адрес
 * остаётся прежним. Поэтому переадресация временная (302) и без кэша.
 *
 * Публичная, без входа: её открывает мама. Ничего не пишет о человеке — только
 * +1 к числу переходов за день, и то не для превью мессенджеров (WhatsApp и
 * Telegram сами открывают ссылку, чтобы показать карточку).
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const target = await promoLinkTarget().catch(() => null);
  if (!target) {
    return new Response("Ссылка временно не работает. Напишите нам в WhatsApp или позвоните в клинику.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex", "cache-control": "no-store" },
    });
  }
  if (target.counted && !isPreviewBot(req.headers.get("user-agent"))) {
    // После ответа: переход не ждёт записи в базу.
    after(() => notePromoLinkClick(target.companyId));
  }
  return new Response(null, {
    status: 302,
    headers: { location: target.url, "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}
