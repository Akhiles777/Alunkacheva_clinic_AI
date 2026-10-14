import Link from "next/link";
import { getSession } from "@/lib/server/session";
import { can } from "@/lib/server/authz";
import { listPromos } from "@/lib/server/promos";
import { formatMoney, formatNumber } from "@/lib/format";
import { CLINIC_TZ } from "@/lib/clinic-time";

export const metadata = { title: "Акции" };

const dateFmt = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: CLINIC_TZ,
});

/**
 * Акции клиники и школы-партнёры. Числа считает `schoolTotals` — одна функция
 * для этого экрана, экрана школы и публичного отчёта школы.
 */
export default async function PromosPage() {
  const session = await getSession();
  const [canEdit, canMessage] = await Promise.all([
    can(session, "EDIT_SETTINGS"),
    can(session, "MESSAGE_PATIENTS"),
  ]);
  if (!canEdit && !canMessage) {
    return (
      <div className="flex-1 overflow-auto px-7 py-8 max-md:px-5">
        <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">
          Акции
        </h1>
        <p className="text-text-muted mt-3 max-w-[60ch] text-sm leading-relaxed">
          Раздел доступен тем, кто ведёт переписку с пациентами или настройки
          клиники.
        </p>
      </div>
    );
  }
  const promos = await listPromos(session.companyId);

  return (
    <>
      <header className="border-border flex flex-none items-center justify-between gap-3 border-b px-7 py-[18px] max-md:px-5">
        <div>
          <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">
            Акции
          </h1>
          <p className="text-text-muted mt-1.5 max-w-[70ch] text-xs leading-relaxed max-md:hidden">
            Бонус школе — один за пришедшего ребёнка, начисляется после отметки
            «пришёл» в YCLIENTS и снимается с причиной, если визит отменили.
          </p>
        </div>
        {canEdit ? (
          <Link
            href="/promos/new"
            className="bg-accent text-accent-contrast hover:bg-accent-hover flex-none rounded-md px-3 py-1.5 text-sm font-medium"
          >
            + Новая акция
          </Link>
        ) : null}
      </header>
      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        {promos.length === 0 ? (
          <div className="border-border bg-surface max-w-[640px] rounded-xl border p-5">
            <p className="text-sm font-medium">Акций пока нет</p>
            <p className="text-text-muted mt-1.5 text-sm leading-relaxed">
              {canEdit
                ? "Заведите «Школьный check-up» — форма уже заполнена ценами с макета, останется выбрать услуги YCLIENTS."
                : "Заводит акции владелец клиники."}
            </p>
          </div>
        ) : (
          <ul className="flex max-w-[960px] flex-col gap-2.5">
            {promos.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/promos/${p.id}`}
                  className="border-border bg-surface hover:bg-hover flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border px-4 py-3"
                >
                  <div className="min-w-[220px] flex-1">
                    <p className="text-sm font-medium">{p.name}</p>
                    <p className="text-text-muted mt-0.5 text-xs">
                      {p.open
                        ? `до ${dateFmt.format(new Date(p.endsAt))}`
                        : `закончилась ${dateFmt.format(new Date(p.endsAt))}`}
                      {!p.isActive ? " · выключена" : ""}
                      {p.agentEnabled ? " · агент знает" : " · агент не знает"}
                    </p>
                  </div>
                  <Stat label="школ" value={formatNumber(p.schools)} />
                  <Stat
                    label="привязано"
                    value={formatNumber(p.totals.attributed)}
                  />
                  <Stat label="пришли" value={formatNumber(p.totals.arrived)} />
                  <Stat
                    label="бонус школам"
                    value={formatMoney(p.totals.bonusEarned)}
                  />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-[84px]">
      <p className="num text-sm font-medium">{value}</p>
      <p className="text-text-subtle text-2xs">{label}</p>
    </div>
  );
}
