"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatMoney, formatNumber } from "@/lib/format";
import type { SchoolDetail } from "@/lib/server/promos";
import { Toggle } from "../../settings/_components/ui";
import { detachPatientFromSchool, rotateSchoolToken, saveSchool } from "../../promos/actions";

const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric" });

export function SchoolClient({ school, reportUrl, canEdit }: { school: SchoolDetail; reportUrl: string; canEdit: boolean }) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = school.patients.filter((p) => !p.removedAt);
  const removed = school.patients.filter((p) => p.removedAt);
  const reversed = school.patients.filter((p) => p.bonus?.status === "REVERSED");

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не получилось");
    }
  }

  return (
    <>
      <header className="border-border flex-none border-b px-7 py-[18px] max-md:px-5">
        <Link href={`/promos/${school.promo.id}`} className="text-text-muted hover:text-text text-xs">
          ← {school.promo.name}
        </Link>
        <h1 className="mt-1 text-xl leading-none font-medium tracking-[-0.015em]">{school.name}</h1>
        <p className="text-text-muted mt-1.5 text-xs">
          {[school.contactName, school.contactPhone].filter(Boolean).join(" · ") || "контакт не указан"}
          {!school.isActive ? " · школа выключена — её отчёт не открывается" : ""}
        </p>
      </header>

      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <div className="flex max-w-[960px] flex-col gap-5">
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            <Tile label="Привязано" value={formatNumber(school.totals.attributed)} />
            <Tile label="Пришли" value={formatNumber(school.totals.arrived)} />
            <Tile label="Бонус школе" value={formatMoney(school.totals.bonusEarned)} />
            <Tile
              label="Снято бонусов"
              value={formatNumber(school.totals.reversed)}
              hint={school.totals.reversed ? `на ${formatMoney(school.totals.bonusReversed)}` : "визиты не отменяли"}
            />
          </div>

          <section className="border-border bg-surface rounded-xl border px-5 py-4">
            <h2 className="text-sm font-medium">Ссылка для школы</h2>
            <p className="text-text-subtle mt-0.5 text-xs">
              Только итоги: сколько привязано, сколько пришло и сумма бонуса. Ни имён, ни телефонов, ни дат — школа
              может переслать её в общий чат.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <code className="bg-raise border-border min-w-0 flex-1 basis-full truncate rounded-md border px-3 py-2 text-xs sm:basis-0">{reportUrl}</code>
              <button
                type="button"
                className="border-border hover:bg-hover rounded-md border px-3 py-2 text-sm"
                onClick={async () => {
                  await navigator.clipboard.writeText(reportUrl).catch(() => {});
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? "Скопировано" : "Скопировать"}
              </button>
              <a href={reportUrl} target="_blank" rel="noreferrer" className="border-border hover:bg-hover rounded-md border px-3 py-2 text-sm">
                Открыть
              </a>
              {canEdit ? (
                <button
                  type="button"
                  className="text-text-muted hover:text-text px-2 py-2 text-xs"
                  onClick={() => {
                    if (confirm("Старая ссылка перестанет открываться. Выдать новую?")) void run(() => rotateSchoolToken(school.id));
                  }}
                >
                  Выдать новую ссылку
                </button>
              ) : null}
            </div>
            {canEdit ? (
              <label className="mt-3 flex items-center gap-3 text-sm">
                <Toggle
                  checked={school.isActive}
                  label="Школа участвует"
                  onChange={(v) =>
                    void run(() =>
                      saveSchool({
                        id: school.id,
                        promoId: school.promo.id,
                        name: school.name,
                        contactName: school.contactName,
                        contactPhone: school.contactPhone,
                        isActive: v,
                      }),
                    )
                  }
                />
                Школа участвует — её можно выбрать в карточке пациента
              </label>
            ) : null}
          </section>

          {error ? <p className="text-accent-text text-sm">{error}</p> : null}

          <section className="border-border bg-surface rounded-xl border">
            <header className="border-border-soft border-b px-5 py-3">
              <h2 className="text-sm font-medium">Пациенты по привязке</h2>
              <p className="text-text-subtle mt-0.5 text-xs">Привязку ставят в карточке пациента в «Диалогах».</p>
            </header>
            {active.length === 0 ? (
              <p className="text-text-muted px-5 py-4 text-sm">Пока никого не привязали.</p>
            ) : (
              <ul>
                {active.map((p) => (
                  <li key={p.attributionId} className="border-border-soft flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-5 py-2.5 last:border-b-0">
                    <div className="min-w-[200px] flex-1">
                      <Link href={`/patients/${p.patientId}`} className="text-sm hover:underline">
                        {p.patientName}
                      </Link>
                      {p.note ? <span className="text-text-muted text-sm"> · {p.note}</span> : null}
                      {p.isExtraChild ? <span className="text-text-subtle text-xs"> · ещё один ребёнок семьи</span> : null}
                      <p className="text-text-subtle text-2xs">
                        {p.source === "AGENT" ? "привязал агент" : `привязал(а) ${p.createdBy ?? "сотрудник"}`} ·{" "}
                        {dateFmt.format(new Date(p.attributedAt))}
                      </p>
                    </div>
                    <BonusCell bonus={p.bonus} />
                    <button
                      type="button"
                      className="text-text-muted hover:text-text text-xs"
                      onClick={() => {
                        if (confirm("Снять привязку? Начисленный бонус будет снят с причиной.")) void run(() => detachPatientFromSchool(p.attributionId));
                      }}
                    >
                      Снять
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {reversed.length || removed.length ? (
            <section className="border-border bg-surface rounded-xl border px-5 py-4">
              <h2 className="text-sm font-medium">Снятые бонусы и привязки</h2>
              <p className="text-text-subtle mt-0.5 text-xs">Не исчезают молча: здесь видно, что и почему сняли.</p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {[...new Map([...reversed, ...removed].map((p) => [p.attributionId, p])).values()].map((p) => (
                  <li key={p.attributionId} className="text-sm">
                    {p.patientName}
                    {p.note ? ` · ${p.note}` : ""} —{" "}
                    <span className="text-text-muted">
                      {p.bonus?.status === "REVERSED"
                        ? `бонус ${formatMoney(p.bonus.amount)} снят: ${p.bonus.reverseReason ?? "причина не записана"}`
                        : "привязка снята, бонуса не было"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}

function BonusCell({ bonus }: { bonus: SchoolDetail["patients"][number]["bonus"] }) {
  if (!bonus) return <span className="text-text-subtle text-xs">ждём визита</span>;
  if (bonus.status === "REVERSED") return <span className="text-accent-text text-xs">бонус снят</span>;
  return (
    <span className="num text-xs">
      +{formatMoney(bonus.amount)} · пришёл {dateFmt.format(new Date(bonus.earnedAt))}
    </span>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border-border bg-surface rounded-xl border px-4 py-3">
      <p className="text-text-subtle text-2xs">{label}</p>
      <p className="num mt-1 text-lg font-medium">{value}</p>
      {hint ? <p className="text-text-subtle mt-0.5 text-2xs">{hint}</p> : null}
    </div>
  );
}
