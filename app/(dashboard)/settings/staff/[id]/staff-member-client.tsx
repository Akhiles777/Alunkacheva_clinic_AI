"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { formatMoney } from "@/lib/format";
import type { Permission } from "@/lib/permissions";
import { Group } from "../../_components/ui";
import {
  addPayout,
  saveStaffPermissions,
  saveStaffRate,
  type PermissionSetting,
  type StaffMemberView,
  type WeekRow,
} from "./actions";
import type { ServiceKind } from "@/generated/prisma/enums";

const ROLE_LABEL: Record<string, string> = {
  OWNER: "Владелец",
  MANAGER: "Управляющий",
  ADMIN: "Администратор",
  DOCTOR: "Врач",
};

const PERMISSION_LABEL: Record<Permission, string> = {
  VIEW_OTHER_PATIENTS: "Видит чужих пациентов",
  VIEW_REVENUE: "Видит выручку",
  MESSAGE_PATIENTS: "Пишет пациентам",
  EDIT_SETTINGS: "Меняет настройки",
  VIEW_AUDIT: "Видит журнал аудита",
};

const PERMISSION_HINT: Record<Permission, string> = {
  VIEW_OTHER_PATIENTS: "карточки пациентов, которых ведёт не он",
  VIEW_REVENUE: "суммы, средний чек, отчёты по деньгам",
  MESSAGE_PATIENTS: "отправка сообщений в Instagram и WhatsApp",
  EDIT_SETTINGS: "сотрудники, услуги, цены, интеграции",
  VIEW_AUDIT: "кто и когда открывал карточки",
};

function Tile({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="border-border-soft rounded-lg border px-3 py-2.5">
      <div className="text-text-subtle text-2xs">{label}</div>
      <div className="readout mt-0.5 text-base">{value}</div>
      {hint ? <div className="text-text-subtle mt-0.5 text-2xs">{hint}</div> : null}
    </div>
  );
}

/** Недельная нагрузка: приёмы столбиками, подпись у максимума и последней. */
function WeeksChart({ weeks }: { weeks: WeekRow[] }) {
  if (weeks.length === 0) {
    return <p className="text-text-subtle text-sm">За период визитов не было.</p>;
  }
  const values = weeks.map((w) => w.arrived);
  const max = Math.max(1, ...values);
  const maxIndex = values.indexOf(max);
  return (
    <div>
      <div className="flex h-[92px] items-end gap-[3px]">
        {weeks.map((w, i) => {
          const labelled = i === maxIndex || i === weeks.length - 1;
          return (
            <div key={w.label} className="group relative flex h-full min-w-0 flex-1 flex-col">
              <div className="text-text-muted h-3.5 text-center text-[10px] leading-none">
                {labelled ? w.arrived : ""}
              </div>
              <div className="flex min-h-0 flex-1 items-end">
                <div
                  style={{ height: `${Math.max(3, Math.round((w.arrived / max) * 100))}%` }}
                  className={`w-full rounded-t ${
                    i === weeks.length - 1 ? "bg-accent" : "bg-accent-border"
                  } group-hover:bg-accent`}
                />
              </div>
              <div className="border-border bg-surface pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded-md border px-2 py-1 text-center whitespace-nowrap group-hover:block">
                <div className="text-text-subtle text-[10px]">неделя {w.label}</div>
                <div className="num text-xs">
                  {w.arrived} из {w.appts}
                </div>
                <div className="text-text-subtle num text-[10px]">{formatMoney(w.revenue)}</div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="border-border-soft mt-1 flex gap-[3px] border-t pt-1">
        {weeks.map((w) => (
          <div key={w.label} className="text-text-subtle min-w-0 flex-1 truncate text-center text-[10px]">
            {w.label}
          </div>
        ))}
      </div>
    </div>
  );
}

const PROCEDURE_KINDS: { value: ServiceKind | ""; label: string }[] = [
  { value: "", label: "нет выплат за процедуру" },
  { value: "IV_THERAPY", label: "IV-терапия (ВВП)" },
  { value: "OSTEOPATHY", label: "Остеопатия" },
  { value: "BIOFEEDBACK", label: "БОС-терапия" },
  { value: "NEUROMEDITATION", label: "Нейромедитация" },
  { value: "LAB", label: "Анализы" },
];

/**
 * Оплата труда за месяц. Выплаты за процедуры вычитаются из начисленного —
 * это аванс, выданный в смену, а не добавка сверх часов.
 */
function PayrollBlock({ member }: { member: StaffMemberView }) {
  const p = member.payroll!;
  const [hourly, setHourly] = useState(String(p.hourlyRate));
  const [perProc, setPerProc] = useState(String(p.perProcedureRate));
  const [kind, setKind] = useState<ServiceKind | "">(p.procedureKind ?? "");
  const [payout, setPayout] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Ставки и выплаты привязаны к карточке специалиста: без неё считать нечего.
  if (!member.staffId) return null;

  return (
    <Group
      title="Оплата труда"
      hint={`${p.periodLabel} · выплаты за процедуры идут в счёт часов, а не сверх них`}
    >
      {error ? <p className="text-accent-text text-sm">{error}</p> : null}

      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <Tile label="Часы" value={p.hours.toFixed(1)} />
        <Tile label="Начислено" value={formatMoney(p.accrued)} hint={`${p.hourlyRate} ₽/час`} />
        <Tile label="Выдано в смены" value={formatMoney(p.paidOut)} hint={`процедур ${p.procedures}`} />
        <Tile label="К выплате" value={formatMoney(p.remainder)} hint="начислено − выдано" />
      </div>

      {p.advanceMismatch !== 0 ? (
        <p className="text-text-muted mt-1 text-xs">
          Факт выдачи отличается от ожидаемого на {formatMoney(p.advanceMismatch)} — проверьте,
          все ли выдачи отмечены.
        </p>
      ) : null}

      <div className="border-border-soft mt-4 grid grid-cols-[1fr_1fr_1.4fr] items-end gap-2.5 border-t pt-4 max-md:grid-cols-1">
        <label className="flex flex-col gap-1">
          <span className="text-text-subtle text-2xs">Ставка за час, ₽</span>
          <input
            value={hourly}
            onChange={(e) => setHourly(e.target.value)}
            inputMode="decimal"
            className="border-border-input bg-surface rounded-md border px-3 py-2 text-sm outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-text-subtle text-2xs">За процедуру, ₽</span>
          <input
            value={perProc}
            onChange={(e) => setPerProc(e.target.value)}
            inputMode="decimal"
            className="border-border-input bg-surface rounded-md border px-3 py-2 text-sm outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-text-subtle text-2xs">Какая услуга считается процедурой</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as ServiceKind | "")}
            className="border-border-input bg-surface rounded-md border px-2.5 py-2 text-sm outline-none"
          >
            {PROCEDURE_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-end gap-2.5">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              try {
                await saveStaffRate(member.staffId!, {
                  hourlyRate: Number(hourly) || 0,
                  perProcedureRate: Number(perProc) || 0,
                  procedureKind: kind || null,
                });
                setSaved("Ставки сохранены");
                setError(null);
              } catch (e) {
                setError(e instanceof Error ? e.message : "Не удалось сохранить");
              }
            })
          }
          className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-4 py-2 text-sm font-medium disabled:opacity-45"
        >
          Сохранить ставки
        </button>

        <label className="flex flex-col gap-1">
          <span className="text-text-subtle text-2xs">Выдано на руки, ₽</span>
          <input
            value={payout}
            onChange={(e) => setPayout(e.target.value)}
            inputMode="decimal"
            placeholder="например, 500"
            className="border-border-input bg-surface w-36 rounded-md border px-3 py-2 text-sm outline-none"
          />
        </label>
        <button
          type="button"
          disabled={pending || !payout.trim()}
          onClick={() =>
            start(async () => {
              try {
                await addPayout(member.staffId!, Number(payout), "выдано в смену");
                setPayout("");
                setSaved("Выдача отмечена — обновите страницу");
                setError(null);
              } catch (e) {
                setError(e instanceof Error ? e.message : "Не удалось отметить");
              }
            })
          }
          className="border-border text-text-muted hover:bg-hover rounded-md border px-3 py-2 text-sm disabled:opacity-45"
        >
          Отметить выдачу
        </button>
        {saved && !pending ? <span className="text-text-muted text-sm">{saved}</span> : null}
      </div>
    </Group>
  );
}

export function StaffMemberClient({ initial }: { initial: StaffMemberView }) {
  const [member, setMember] = useState(initial);
  const [draft, setDraft] = useState<Record<string, PermissionSetting>>(
    Object.fromEntries(initial.permissions.map((p) => [p.permission, p.personal])),
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  const m = member.metrics;
  const dirty = member.permissions.some((p) => (draft[p.permission] ?? null) !== p.personal);

  function set(permission: string, value: PermissionSetting) {
    setDraft((d) => ({ ...d, [permission]: value }));
    setSaved(false);
    setError(null);
  }

  function save() {
    start(async () => {
      try {
        const fresh = await saveStaffPermissions(member.id, draft);
        if (fresh) {
          setMember(fresh);
          setDraft(Object.fromEntries(fresh.permissions.map((p) => [p.permission, p.personal])));
        }
        setSaved(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Не удалось сохранить");
      }
    });
  }

  return (
    <div className="flex max-w-[860px] flex-col gap-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link href="/settings/staff" className="text-text-subtle hover:text-text text-xs">
          ← ко всем сотрудникам
        </Link>
        <span className="text-text-subtle text-2xs">
          {ROLE_LABEL[member.role] ?? member.role}
          {member.specialty ? ` · ${member.specialty}` : ""}
          {member.roomName ? ` · ${member.roomName.replace(/ —.*/, "")}` : ""}
          {member.isActive ? "" : " · отключён"}
        </span>
      </div>

      {/* Специалисту без входа нечего показывать про логин и права: у него их
          нет. Ставки и расчёт зарплаты ниже — они от учётной записи не зависят. */}
      {!member.hasAccount ? (
        <Group title="Учётная запись" hint="специалист работает в расписании, входа в систему у него нет">
          <p className="text-text-subtle text-sm">
            Чтобы выдать доступ, задайте логин и пароль в общем списке сотрудников. Ставки и
            расчёт зарплаты ниже работают и без входа.
          </p>
        </Group>
      ) : (
      <Group title="Учётная запись" hint="логин и роль меняются в общем списке сотрудников">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm max-md:grid-cols-1">
          <div className="flex justify-between gap-3">
            <dt className="text-text-subtle">Логин</dt>
            <dd className="truncate">{member.login}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-text-subtle">Последний вход</dt>
            <dd className="num">
              {member.lastLoginAt
                ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(
                    new Date(member.lastLoginAt),
                  )
                : "ещё не входил"}
            </dd>
          </div>
        </dl>
      </Group>
      )}

      {member.hasAccount ? (
      <Group
        title="Права доступа"
        hint="настраиваются лично для этого сотрудника; «как у роли» — наследует общую матрицу"
      >
        {error ? <p className="text-accent-text text-sm">{error}</p> : null}
        <ul className="flex flex-col gap-2">
          {member.permissions.map((p) => {
            const value = draft[p.permission] ?? null;
            const effective = value === null ? p.fromRole : value;
            return (
              <li
                key={p.permission}
                className="border-border-soft flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{PERMISSION_LABEL[p.permission]}</div>
                  <div className="text-text-subtle text-2xs">{PERMISSION_HINT[p.permission]}</div>
                </div>
                <span
                  className={`rounded-md px-2 py-0.5 text-2xs ${
                    effective ? "bg-accent-tint text-accent-text" : "bg-chip text-text-muted"
                  }`}
                >
                  {effective ? "есть доступ" : "нет доступа"}
                </span>
                <div className="flex flex-none overflow-hidden rounded-md border border-[color:var(--border-input)]">
                  {(
                    [
                      [null, `как у роли (${p.fromRole ? "да" : "нет"})`],
                      [true, "разрешить"],
                      [false, "запретить"],
                    ] as [PermissionSetting, string][]
                  ).map(([option, label]) => (
                    <button
                      key={String(option)}
                      type="button"
                      onClick={() => set(p.permission, option)}
                      className={`px-2.5 py-1.5 text-2xs ${
                        value === option
                          ? "bg-accent text-accent-contrast font-medium"
                          : "text-text-muted hover:bg-hover"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={pending || !dirty}
            className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-4 py-2 text-sm font-medium disabled:opacity-45"
          >
            {pending ? "Сохраняем…" : "Сохранить права"}
          </button>
          {saved && !pending ? <span className="text-text-muted text-sm">Сохранено</span> : null}
        </div>
      </Group>
      ) : null}

      {member.payroll ? <PayrollBlock member={member} /> : null}

      <Group
        title="Работа в цифрах"
        hint={`за последние ${m.periodDays} дней · считается по визитам, отменённые не портят явку`}
      >
        {!m.hasSpecialist ? (
          <p className="text-text-subtle text-sm">
            У этого сотрудника нет карточки специалиста — приёмы на него не оформляются. Метрики приёмов
            появляются у роли «Врач».
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
              <Tile label="Выручка" value={formatMoney(m.revenue)} hint={`${m.revenueSharePct}% клиники`} />
              <Tile label="Средний чек" value={formatMoney(m.avgCheck)} />
              <Tile label="Приёмов" value={m.appts} hint={`пришли ${m.arrived}`} />
              <Tile label="Часы" value={m.hours.toFixed(1)} />
              <Tile label="Явка" value={`${m.arrivalRatePct}%`} hint={`неявок ${m.noShow}`} />
              <Tile label="Неявки" value={`${m.noShowRatePct}%`} hint={`отмен ${m.cancelled}`} />
              <Tile label="Первичных" value={m.firstVisits} hint={`повторных ${m.repeatVisits}`} />
              <Tile label="Пациентов" value={m.uniquePatients} hint="уникальных" />
            </div>

            <div className="mt-4">
              <h3 className="text-text-subtle mb-2 text-2xs">Приёмы по неделям</h3>
              <WeeksChart weeks={m.weeks} />
            </div>

            {m.services.length > 0 ? (
              <div className="mt-5">
                <h3 className="text-text-subtle mb-2 text-2xs">Услуги</h3>
                <div className="-mx-1 overflow-x-auto px-1">
                  <table className="w-full min-w-[380px] border-collapse text-sm">
                    <thead>
                      <tr className="text-text-subtle text-left text-2xs">
                        <th className="py-1.5 pr-3 font-normal">Услуга</th>
                        <th className="py-1.5 pr-3 text-right font-normal">Приёмы</th>
                        <th className="py-1.5 text-right font-normal">Выручка</th>
                      </tr>
                    </thead>
                    <tbody>
                      {m.services.map((s) => (
                        <tr key={s.service} className="border-border-soft border-t">
                          <td className="py-2 pr-3">{s.service}</td>
                          <td className="num py-2 pr-3 text-right">{s.count}</td>
                          <td className="num py-2 text-right">{formatMoney(s.revenue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </>
        )}
      </Group>
    </div>
  );
}
