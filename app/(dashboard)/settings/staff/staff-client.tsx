"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import type { Permission, Role } from "@/lib/permissions";
import { Group, SaveBar, TextInput, Toggle } from "../_components/ui";
import { saveRoleMatrix, type RoleMatrix } from "./actions";
import { saveAccounts, type AccountRow, type StaffPeople } from "./people-actions";

const ROLE_LABEL: Record<Role, string> = {
  OWNER: "Владелец",
  MANAGER: "Управляющий",
  ADMIN: "Администратор",
  DOCTOR: "Врач",
};
const ROLES: Role[] = ["OWNER", "MANAGER", "ADMIN", "DOCTOR"];

const PERMISSION_LABEL: Record<Permission, string> = {
  VIEW_OTHER_PATIENTS: "Видит чужих пациентов",
  VIEW_REVENUE: "Видит выручку",
  MESSAGE_PATIENTS: "Пишет пациентам",
  EDIT_SETTINGS: "Меняет настройки",
  VIEW_AUDIT: "Видит журнал аудита",
};
const PERMISSIONS = Object.keys(PERMISSION_LABEL) as Permission[];

export function StaffClient({
  initialMatrix,
  initialPeople,
}: {
  initialMatrix: RoleMatrix;
  initialPeople: StaffPeople;
}) {
  const [accounts, setAccounts] = useState<AccountRow[]>(initialPeople.accounts);
  const roomOptions = initialPeople.roomOptions;
  const [specialistOptions, setSpecialistOptions] = useState(initialPeople.specialistOptions);
  const [matrix, setMatrix] = useState<RoleMatrix>(initialMatrix);
  const [accError, setAccError] = useState<string | null>(null);
  const [accSaved, setAccSaved] = useState(false);
  /** Что именно произошло при сохранении: удаление должно быть подтверждено. */
  const [accNotice, setAccNotice] = useState<string | null>(null);
  const [matrixSaved, setMatrixSaved] = useState(false);
  const [pending, start] = useTransition();

  const matrixError = !matrix.OWNER.includes("EDIT_SETTINGS")
    ? "Владелец должен уметь менять настройки — иначе некому"
    : null;

  function patchAcc(id: string, next: Partial<AccountRow>) {
    setAccounts((a) => a.map((r) => (r.id === id ? { ...r, ...next } : r)));
    setAccSaved(false);
    setAccError(null);
  }
  function addAcc() {
    setAccounts((a) => [
      ...a,
      {
        id: `new-${Date.now()}`,
        name: "",
        login: "",
        role: "ADMIN",
        isActive: true,
        staffId: null,
        specialty: "",
        defaultRoomId: null,
        password: "",
        hasLogin: true,
      },
    ]);
    setAccSaved(false);
  }
  function removeAcc(id: string) {
    setAccounts((a) => a.filter((r) => r.id !== id));
    setAccSaved(false);
  }
  function saveAcc() {
    start(async () => {
      try {
        const fresh = await saveAccounts(accounts);
        setAccounts(fresh.accounts);
        setSpecialistOptions(fresh.specialistOptions);
        setAccSaved(true);
        setAccNotice(fresh.notice ?? null);
        setAccError(null);
      } catch (e) {
        setAccError(e instanceof Error ? e.message : "Не удалось сохранить");
      }
    });
  }

  function togglePerm(role: Role, permission: Permission) {
    setMatrixSaved(false);
    setMatrix((m) => {
      const has = m[role].includes(permission);
      return { ...m, [role]: has ? m[role].filter((p) => p !== permission) : [...m[role], permission] };
    });
  }

  return (
    <div className="flex max-w-[760px] flex-col gap-5">
      <Group
        title="Сотрудники"
        hint="все, кто работает в клинике: и с доступом в систему, и специалисты без входа. Врачу здесь же задаются специальность и кабинет"
      >
        {accError ? <p className="text-accent-text text-sm">{accError}</p> : null}
        <ul className="flex flex-col gap-3">
          {accounts.map((acc) => {
            const isNew = acc.id.startsWith("new-");
            return (
              <li key={acc.id} className="border-border-soft flex flex-col gap-2.5 rounded-lg border p-3">
                <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-2.5 max-md:grid-cols-1">
                  <TextInput
                    value={acc.name}
                    onChange={(e) => patchAcc(acc.id, { name: e.target.value })}
                    placeholder="Имя сотрудника"
                    className="py-1.5"
                  />
                  <TextInput
                    value={acc.login}
                    onChange={(e) => patchAcc(acc.id, { login: e.target.value })}
                    placeholder={acc.hasLogin ? "логин" : "логин — чтобы выдать вход"}
                    className="py-1.5"
                  />
                  <div className="flex items-center gap-2 max-md:justify-between">
                    {!acc.hasLogin ? (
                      <span
                        className="bg-chip text-text-muted rounded-md px-2 py-0.5 text-2xs whitespace-nowrap"
                        title="Специалист работает в расписании, но входа в систему у него нет. Заполните почту и пароль, чтобы выдать доступ."
                      >
                        нет доступа{acc.visits ? ` · визитов ${acc.visits}` : ""}
                      </span>
                    ) : null}
                    {/* Карточка нужна и специалисту без входа: в ней ставки и
                        расчёт зарплаты. Раньше ссылка была только у тех, у
                        кого есть логин, и медсёстрам задать ставку было негде. */}
                    {!isNew ? (
                      <Link
                        href={`/settings/staff/${acc.id}`}
                        className="text-accent-text text-2xs hover:underline"
                        title={
                          acc.hasLogin
                            ? "Права доступа, метрики и оплата труда"
                            : "Метрики и оплата труда"
                        }
                      >
                        карточка
                      </Link>
                    ) : null}
                    <Toggle
                      checked={acc.isActive}
                      onChange={(v) => patchAcc(acc.id, { isActive: v })}
                      label={`${acc.name} активен`}
                    />
                    <span className="text-text-subtle text-2xs max-md:hidden">активен</span>
                    <button
                      type="button"
                      onClick={() => removeAcc(acc.id)}
                      aria-label={`Удалить ${acc.name}`}
                      className="text-text-subtle hover:text-text flex h-9 w-9 items-center justify-center text-sm"
                    >
                      ×
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-[150px_1fr] items-center gap-2.5 max-md:grid-cols-1">
                  <select
                    value={acc.role}
                    onChange={(e) => patchAcc(acc.id, { role: e.target.value as AccountRow["role"] })}
                    aria-label={`Роль ${acc.name}`}
                    className="border-border-input bg-surface w-full min-w-0 rounded-md border px-2.5 py-2 text-sm outline-none"
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                  <input
                    type="password"
                    value={acc.password ?? ""}
                    onChange={(e) => patchAcc(acc.id, { password: e.target.value })}
                    placeholder={
                      !acc.hasLogin
                        ? "пароль — вместе с логином откроет вход"
                        : isNew
                          ? "пароль (не короче 6)"
                          : acc.hasPassword
                            ? "новый пароль — чтобы сбросить"
                            : "задайте пароль"
                    }
                    className="border-border-input bg-surface w-full rounded-md border px-3 py-2 text-sm outline-none"
                  />
                </div>

                {acc.role === "DOCTOR" ? (
                  <div className="grid grid-cols-[1fr_1fr_1fr] items-center gap-2.5 max-md:grid-cols-1">
                    <select
                      value={acc.staffId ?? ""}
                      onChange={(e) => patchAcc(acc.id, { staffId: e.target.value || null })}
                      aria-label={`Специалист для ${acc.name}`}
                      title="Привязать к существующему специалисту, чтобы не создать дубль в расписании"
                      className="border-border-input bg-surface w-full min-w-0 rounded-md border px-2.5 py-2 text-sm outline-none"
                    >
                      <option value="">создать нового специалиста</option>
                      {specialistOptions
                        .filter((s) => s.takenBy === null || s.id === acc.staffId)
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                            {s.specialty ? ` — ${s.specialty}` : ""}
                          </option>
                        ))}
                    </select>
                    <TextInput
                      value={acc.specialty}
                      onChange={(e) => patchAcc(acc.id, { specialty: e.target.value })}
                      placeholder="специальность (например, невролог)"
                      className="py-1.5"
                    />
                    <select
                      value={acc.defaultRoomId ?? ""}
                      onChange={(e) => patchAcc(acc.id, { defaultRoomId: e.target.value || null })}
                      aria-label={`Кабинет ${acc.name}`}
                      className="border-border-input bg-surface w-full min-w-0 rounded-md border px-2.5 py-2 text-sm outline-none"
                    >
                      <option value="">кабинет не задан</option>
                      {roomOptions.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          onClick={addAcc}
          className="border-border text-text-muted hover:bg-hover self-start rounded-md border px-3 py-1.5 text-sm"
        >
          + Добавить сотрудника
        </button>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={saveAcc}
            disabled={pending}
            className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-4 py-2 text-sm font-medium disabled:opacity-45"
          >
            {pending ? "Сохраняем…" : "Сохранить"}
          </button>
          {accSaved && !pending ? (
            <span className="text-text-muted text-sm">{accNotice ?? "Сохранено"}</span>
          ) : null}
        </div>
      </Group>

      <Group title="Матрица прав" hint="в базе; проверка доступа на сервере читает эти строки">
        {/* Телефон: право — карточка с переключателями по ролям. Таблица здесь
            требовала горизонтальной прокрутки, и экран «ездил» под пальцем. */}
        <div className="flex flex-col gap-3 md:hidden">
          {PERMISSIONS.map((perm) => (
            <div key={perm} className="border-border-soft rounded-lg border p-3">
              <div className="text-sm font-medium">{PERMISSION_LABEL[perm]}</div>
              <div className="mt-2.5 flex flex-col gap-2">
                {ROLES.map((role) => (
                  <label key={role} className="flex items-center justify-between gap-3">
                    <span className="text-text-muted text-sm">{ROLE_LABEL[role]}</span>
                    <Toggle
                      checked={matrix[role].includes(perm)}
                      onChange={() => togglePerm(role, perm)}
                      label={`${ROLE_LABEL[role]}: ${PERMISSION_LABEL[perm]}`}
                    />
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="-mx-1 px-1 max-md:hidden">
          {/* Таблица шире телефона: прокручиваем её саму, а не всю страницу. */}
          <div className="-mx-1 overflow-x-auto px-1">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="text-text-subtle py-2 pr-3 text-left text-2xs font-normal">Право</th>
                  {ROLES.map((r) => (
                    <th key={r} className="text-text-subtle px-2 py-2 text-center text-2xs font-normal">
                      {ROLE_LABEL[r]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PERMISSIONS.map((perm) => (
                  <tr key={perm} className="border-border-soft border-t">
                    <td className="py-2.5 pr-3 text-sm">{PERMISSION_LABEL[perm]}</td>
                    {ROLES.map((role) => (
                      <td key={role} className="px-2 py-2.5 text-center">
                        <div className="inline-flex">
                          <Toggle
                            checked={matrix[role].includes(perm)}
                            onChange={() => togglePerm(role, perm)}
                            label={`${ROLE_LABEL[role]}: ${PERMISSION_LABEL[perm]}`}
                          />
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <SaveBar
            error={matrixError}
            onSave={() => {
              start(async () => {
                await saveRoleMatrix(matrix);
                setMatrixSaved(true);
              });
            }}
          />
          {pending ? (
            <span className="text-text-subtle text-sm">сохраняем…</span>
          ) : matrixSaved ? (
            <span className="text-text-muted text-sm">сохранено в базе</span>
          ) : null}
        </div>
      </Group>
    </div>
  );
}
