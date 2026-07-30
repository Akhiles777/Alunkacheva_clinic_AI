"use client";

import { useState, useTransition } from "react";
import type { Permission, Role } from "@/lib/permissions";
import { Group, SaveBar, TextInput, Toggle } from "../_components/ui";
import { saveRoleMatrix, type RoleMatrix } from "./actions";
import {
  saveAccounts,
  saveSpecialists,
  type AccountRow,
  type SpecialistRow,
  type StaffPeople,
} from "./people-actions";

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
  const [specialists, setSpecialists] = useState<SpecialistRow[]>(initialPeople.specialists);
  const [accounts, setAccounts] = useState<AccountRow[]>(initialPeople.accounts);
  const [roomOptions, setRoomOptions] = useState(initialPeople.roomOptions);
  const [matrix, setMatrix] = useState<RoleMatrix>(initialMatrix);

  const [spError, setSpError] = useState<string | null>(null);
  const [spSaved, setSpSaved] = useState(false);
  const [accError, setAccError] = useState<string | null>(null);
  const [accSaved, setAccSaved] = useState(false);
  const [matrixSaved, setMatrixSaved] = useState(false);
  const [pending, start] = useTransition();

  function applyPeople(p: StaffPeople) {
    setSpecialists(p.specialists);
    setAccounts(p.accounts);
    setRoomOptions(p.roomOptions);
  }

  const matrixError = !matrix.OWNER.includes("EDIT_SETTINGS")
    ? "Владелец должен уметь менять настройки — иначе некому"
    : null;

  // ── специалисты ──
  function patchSp(id: string, next: Partial<SpecialistRow>) {
    setSpecialists((s) => s.map((r) => (r.id === id ? { ...r, ...next } : r)));
    setSpSaved(false);
    setSpError(null);
  }
  function addSp() {
    setSpecialists((s) => [
      ...s,
      { id: `new-${Date.now()}`, name: "", specialty: "", defaultRoomId: null, isActive: true },
    ]);
    setSpSaved(false);
  }
  function removeSp(id: string) {
    setSpecialists((s) => s.filter((r) => r.id !== id));
    setSpSaved(false);
  }
  function saveSp() {
    start(async () => {
      try {
        applyPeople(await saveSpecialists(specialists));
        setSpSaved(true);
        setSpError(null);
      } catch (e) {
        setSpError(e instanceof Error ? e.message : "Не удалось сохранить");
      }
    });
  }

  // ── учётные записи ──
  function patchAcc(id: string, next: Partial<AccountRow>) {
    setAccounts((a) => a.map((r) => (r.id === id ? { ...r, ...next } : r)));
    setAccSaved(false);
    setAccError(null);
  }
  function addAcc() {
    setAccounts((a) => [
      ...a,
      { id: `new-${Date.now()}`, name: "", email: "", role: "ADMIN", isActive: true, staffId: null },
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
        applyPeople(await saveAccounts(accounts));
        setAccSaved(true);
        setAccError(null);
      } catch (e) {
        setAccError(e instanceof Error ? e.message : "Не удалось сохранить");
      }
    });
  }

  // ── матрица ──
  function togglePerm(role: Role, permission: Permission) {
    setMatrixSaved(false);
    setMatrix((m) => {
      const has = m[role].includes(permission);
      return { ...m, [role]: has ? m[role].filter((p) => p !== permission) : [...m[role], permission] };
    });
  }

  return (
    <div className="flex max-w-[760px] flex-col gap-5">
      <Group title="Специалисты" hint="кто принимает; закреплённый кабинет — необязателен">
        {spError ? <p className="text-accent-text text-sm">{spError}</p> : null}
        <ul className="flex flex-col gap-2.5">
          {specialists.map((sp) => (
            <li key={sp.id} className="grid grid-cols-[1fr_170px_auto_auto] items-center gap-2.5 max-md:grid-cols-1">
              <TextInput
                value={sp.name}
                onChange={(e) => patchSp(sp.id, { name: e.target.value })}
                placeholder="Имя специалиста"
                className="py-1.5"
              />
              <TextInput
                value={sp.specialty}
                onChange={(e) => patchSp(sp.id, { specialty: e.target.value })}
                placeholder="Специальность"
                className="py-1.5"
              />
              <select
                value={sp.defaultRoomId ?? ""}
                onChange={(e) => patchSp(sp.id, { defaultRoomId: e.target.value || null })}
                aria-label={`Кабинет ${sp.name}`}
                className="border-border-input bg-surface rounded-md border px-2.5 py-1.5 text-sm outline-none"
              >
                <option value="">принимает в разных</option>
                {roomOptions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
              <div className="flex items-center gap-2">
                <Toggle
                  checked={sp.isActive}
                  onChange={(v) => patchSp(sp.id, { isActive: v })}
                  label={`${sp.name} активен`}
                />
                <button
                  type="button"
                  onClick={() => removeSp(sp.id)}
                  aria-label={`Удалить ${sp.name}`}
                  className="text-text-subtle hover:text-text px-1 text-sm"
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={addSp}
          className="border-border text-text-muted hover:bg-hover self-start rounded-md border px-3 py-1.5 text-sm"
        >
          + Добавить специалиста
        </button>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={saveSp}
            disabled={pending}
            className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-4 py-2 text-sm font-medium disabled:opacity-45"
          >
            {pending ? "Сохраняем…" : "Сохранить"}
          </button>
          {spSaved && !pending ? <span className="text-text-muted text-sm">Сохранено</span> : null}
        </div>
      </Group>

      <Group title="Учётные записи" hint="доступ сотрудников в систему; должен остаться активный владелец">
        {accError ? <p className="text-accent-text text-sm">{accError}</p> : null}
        <ul className="flex flex-col gap-2.5">
          {accounts.map((acc) => (
            <li key={acc.id} className="grid grid-cols-[1fr_1fr_150px_auto] items-center gap-2.5 max-md:grid-cols-1">
              <TextInput
                value={acc.name}
                onChange={(e) => patchAcc(acc.id, { name: e.target.value })}
                placeholder="Имя"
                className="py-1.5"
              />
              <TextInput
                value={acc.email}
                onChange={(e) => patchAcc(acc.id, { email: e.target.value })}
                placeholder="почта@клиника"
                className="py-1.5"
              />
              <select
                value={acc.role}
                onChange={(e) => patchAcc(acc.id, { role: e.target.value as AccountRow["role"] })}
                aria-label={`Роль ${acc.name}`}
                className="border-border-input bg-surface rounded-md border px-2.5 py-1.5 text-sm outline-none"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
              <div className="flex items-center gap-2">
                <Toggle
                  checked={acc.isActive}
                  onChange={(v) => patchAcc(acc.id, { isActive: v })}
                  label={`${acc.name} активен`}
                />
                <button
                  type="button"
                  onClick={() => removeAcc(acc.id)}
                  aria-label={`Удалить ${acc.name}`}
                  className="text-text-subtle hover:text-text px-1 text-sm"
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={addAcc}
          className="border-border text-text-muted hover:bg-hover self-start rounded-md border px-3 py-1.5 text-sm"
        >
          + Добавить учётную запись
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
          {accSaved && !pending ? <span className="text-text-muted text-sm">Сохранено</span> : null}
        </div>
      </Group>

      <Group title="Матрица прав" hint="в базе; проверка доступа на сервере читает эти строки">
        <div className="-mx-1 overflow-x-auto px-1">
          <table className="w-full min-w-[520px] border-collapse">
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
