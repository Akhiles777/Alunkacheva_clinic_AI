import { notFound } from "next/navigation";
import { getPartnerReport } from "@/lib/server/promos";
import { PartnerReportView } from "./report-view";

export const dynamic = "force-dynamic";

/**
 * Отчёт школы — ТОЛЬКО агрегаты: привязано, пришло, бонус. Ни имён, ни
 * телефонов, ни услуг, ни дат визитов (§7): ссылку увидят родители в общем
 * чате. Неверная или отключённая ссылка — «страница не найдена», без
 * подсказки, существовала ли она.
 */
export default async function PartnerReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const report = await getPartnerReport(token);
  if (!report) notFound();
  return <PartnerReportView report={report} />;
}
