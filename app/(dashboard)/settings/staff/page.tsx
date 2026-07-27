"use client";

import { useState } from "react";
import {
  settingsStore,
  type StaffAccount,
  type StaffSettings,
} from "@/app/_data/settings";
import type { Permission, Role } from "@/lib/permissions";
import { Group, SaveBar, SettingsHeader, TextInput, Toggle } from "../_components/ui";

const ROOM_OPTIONS = settingsStore.rooms.map((r) => ({ id: r.id, label: r.name.replace(/ —.*/, "") }));

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

export default function StaffSettingsPage() {
  const [staff, setStaff] = useState<StaffSettings[]>(() => structuredClone(settingsStore.staff));
  const [accounts, setAccounts] = useState<StaffAccount[]>(() =>
    structuredClone(settingsStore.accounts),
  );
  const [matrix, setMatrix] = useState<Record<Role, Permission[]>>(() =>
    structuredClone(settingsStore.roleMatrix),
  );

  const badAccount = accounts.find((a) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.email));
  const noOwner = !matrix.OWNER.includes("EDIT_SETTINGS");
  const error = badAccount
    ? `Проверьте почту: ${badAccount.name}`
    : noOwner
      ? "Владелец должен уметь менять настройки — иначе некому"
      : null;

  function patchStaff(id: string, next: Partial<StaffSettings>) {
    setStaff((s) => s.map((r) => (r.id === id ? { ...r, ...next } : r)));
  }
  function patchAccount(id: string, next: Partial<StaffAccount>) {
    setAccounts((a) => a.map((r) => (r.id === id ? { ...r, ...next } : r)));
  }
  function togglePerm(role: Role, permission: Permission) {
    setMatrix((m) => {
      const has = m[role].includes(permission);
      return {
        ...m,
        [role]: has ? m[role].filter((p) => p !== permission) : [...m[role], permission],
      };
    });
  }

  return (
    <>
      <SettingsHeader
        title="Сотрудники"
        description="Специалисты и их кабинеты, учётные записи и роли. Матрица прав определяет, кто что видит и может, — проверка идёт на сервере, а не только прячет кнопки."
      />
      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <div className="flex max-w-[760px] flex-col gap-5">
          <Group title="Специалисты" hint="закреплённый кабинет — или принимает в разных">
            <ul className="flex flex-col gap-2">
              {staff.map((sp) => (
                <li key={sp.id} className="grid grid-cols-[1fr_auto] items-center gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{sp.name}</p>
                    <p className="text-text-subtle truncate text-xs">{sp.specialty}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      value={sp.roomId ?? ""}
                      onChange={(e) => patchStaff(sp.id, { roomId: e.target.value || null })}
                      className="border-border-input bg-surface rounded-md border px-2.5 py-1.5 text-sm outline-none"
                    >
                      <option value="">принимает в разных</option>
                      {ROOM_OPTIONS.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                    <Toggle
                      checked={sp.isActive}
                      onChange={(v) => patchStaff(sp.id, { isActive: v })}
                      label={`${sp.name} активен`}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </Group>

          <Group title="Учётные записи" hint="доступ сотрудников в систему">
            <ul className="flex flex-col gap-2.5">
              {accounts.map((acc) => (
                <li key={acc.id} className="grid grid-cols-[1fr_180px_auto] items-center gap-3 max-md:grid-cols-1">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{acc.name}</p>
                    <TextInput
                      value={acc.email}
                      onChange={(e) => patchAccount(acc.id, { email: e.target.value })}
                      className="mt-1 py-1.5"
                    />
                  </div>
                  <select
                    value={acc.role}
                    onChange={(e) => patchAccount(acc.id, { role: e.target.value as Role })}
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
                      onChange={(v) => patchAccount(acc.id, { isActive: v })}
                      label={`${acc.name} активен`}
                    />
                    <span className="text-text-subtle text-xs">активен</span>
                  </div>
                </li>
              ))}
            </ul>
          </Group>

          <Group title="Матрица прав" hint="кто что видит и может">
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
          </Group>

          <SaveBar
            error={error}
            onSave={() => {
              settingsStore.staff = structuredClone(staff);
              settingsStore.accounts = structuredClone(accounts);
              settingsStore.roleMatrix = structuredClone(matrix);
            }}
          />
        </div>
      </div>
    </>
  );
}
