import { notFound } from "next/navigation";
import { getSession } from "@/lib/server/session";
import { getSystemReport, SYSTEM_WINDOW_DAYS } from "@/lib/server/system-report";
import { SistemClient } from "./sistem-client";

/**
 * `/sistem` — учёт входов и действий.
 *
 * Раздела нет ни в навигации, ни в поиске, ни в справке: владелец набирает
 * адрес сам. Но скрытый адрес — не защита, а лишь отсутствие подсказки: набрать
 * его может кто угодно, а здесь видно, кто из сотрудников чем занимается.
 * Поэтому чужому раздел отвечает «страница не найдена» — ровно так же, как
 * несуществующий адрес. Так у того, кто пришёл наугад, не остаётся и намёка,
 * что здесь что-то есть.
 */
/**
 * Заголовка у раздела намеренно нет.
 *
 * `metadata` в Next вычисляется до отрисовки и остаётся на странице даже
 * тогда, когда сама страница ответила «не найдено». Из-за этого администратор,
 * набравший адрес наугад, видел в заголовке вкладки слово «Учёт» — то есть
 * узнавал, что раздел существует, ровно там, где не должен был. Без своего
 * заголовка страница неотличима от любого несуществующего адреса.
 */
export default async function SistemPage() {
  const session = await getSession();
  if (session.role !== "OWNER") notFound();

  const report = await getSystemReport(session.companyId, SYSTEM_WINDOW_DAYS);
  return <SistemClient initial={report} />;
}
