"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Роль текущего пользователя для демо личных кабинетов. Реальной авторизации
 * пока нет (сессия дев-режима — владелец), поэтому роль переключается вручную и
 * запоминается в localStorage. Когда появится вход, currentRole придёт из сессии.
 */
export type AppRole = "owner" | "admin" | "doctor";

export interface Doctor {
  name: string;
  specialty: string;
  roomId: string;
  roomName: string;
}

/** Врачи демо — имена совпадают с полем doctor в записях (db.appointments). */
export const DOCTORS: Doctor[] = [
  { name: "Левин А.", specialty: "Остеопат", roomId: "room-3", roomName: "Кабинет 3 · остеопат" },
  { name: "Соколова Е.", specialty: "IV-терапевт", roomId: "room-1", roomName: "Кабинет 1 · процедурный" },
  { name: "Мороз Д.", specialty: "БОС-терапевт", roomId: "room-2", roomName: "Кабинет 2 · БОС" },
  { name: "Литвинова О. А.", specialty: "Медсестра", roomId: "room-1", roomName: "Кабинет 1 · процедурный" },
];

export const ROLE_LABEL: Record<AppRole, string> = {
  owner: "Владелец",
  admin: "Администратор",
  doctor: "Врач",
};

interface RoleState {
  role: AppRole;
  doctorName: string;
}

const STORAGE_KEY = "mera.role";
/** Дефолт для SSR и первого клиентского рендера — одинаков, иначе гидрация ломается. */
const DEFAULT: RoleState = { role: "admin", doctorName: DOCTORS[0].name };
let state: RoleState = DEFAULT;
let loaded = false;
const listeners = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) commit({ ...state, ...JSON.parse(raw) });
  } catch {
    // ignore
  }
}

function commit(next: RoleState) {
  state = next;
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }
  listeners.forEach((l) => l());
}

export function setRole(role: AppRole) {
  commit({ ...state, role });
}
export function setDoctor(doctorName: string) {
  commit({ ...state, doctorName });
}

export function useRole(): RoleState & { doctor: Doctor } {
  // До монтирования возвращаем DEFAULT — одинаково на сервере и в первом
  // клиентском рендере, поэтому гидрация не расходится. После mount читаем
  // localStorage и переключаемся на сохранённую роль.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    load();
    // setState откладываем на следующий кадр — не синхронно в эффекте.
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const snap = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => DEFAULT,
  );
  const effective = mounted ? snap : DEFAULT;
  const doctor = DOCTORS.find((d) => d.name === effective.doctorName) ?? DOCTORS[0];
  return { ...effective, doctor };
}
