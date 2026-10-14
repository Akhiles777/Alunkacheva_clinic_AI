import { CLINIC_NAME } from "@/lib/brand";
import { formatMoney, formatNumber } from "@/lib/format";
import type { PartnerReport } from "@/lib/server/promos";

/**
 * Вид отчёта школы. Только то, что есть в `PartnerReport`: три итога и
 * названия. Ни имён, ни дат — сюда их просто нечем передать.
 */
export function PartnerReportView({ report }: { report: PartnerReport }) {
  return (
    <main className="mx-auto max-w-[560px] px-5 py-10">
      <p className="text-text-muted text-xs">{CLINIC_NAME}</p>
      <h1 className="mt-1 text-xl font-medium tracking-[-0.015em] text-balance">{report.school}</h1>
      <p className="text-text-muted mt-1 text-sm">Акция «{report.promo}»</p>
      <dl className="mt-6 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <Stat label="Привязано учеников" value={formatNumber(report.attributed)} />
        <Stat label="Пришли на приём" value={formatNumber(report.arrived)} />
        <Stat label="Бонус школе" value={formatMoney(report.bonusEarned)} />
      </dl>
      <p className="text-text-subtle mt-6 text-xs leading-relaxed">
        {report.attributed === 0
          ? "Пока никого не привязали — числа появятся, когда первые ученики запишутся по акции."
          : "Бонус начисляется за ученика, который пришёл на приём по акции. Если визит отменили, бонус снимается."}
      </p>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border bg-surface rounded-xl border px-4 py-3">
      <dt className="text-text-subtle text-2xs">{label}</dt>
      <dd className="num mt-1 text-lg font-medium">{value}</dd>
    </div>
  );
}
