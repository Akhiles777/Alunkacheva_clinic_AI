import crypto from "node:crypto";
import { cookies } from "next/headers";

/**
 * Метка браузера для учёта устройств (`/sistem`).
 *
 * По строке браузера два одинаковых аппарата не различить (см.
 * `lib/metrics/device.ts`), поэтому при входе браузер получает случайный номер
 * и хранит его у себя. Это не персональные данные и не слежка за пациентами:
 * номер есть только у сотрудников, вошедших в платформу, и связывает действия
 * в журнале с конкретным аппаратом — ровно то, что журнал и должен уметь (§7).
 *
 * Выход из учётки метку не стирает: это тот же аппарат, и при следующем входе
 * он должен остаться собой, а не стать «новым устройством».
 */
export const DEVICE_COOKIE = "mera_device";

const VALID = /^[a-f0-9]{24}$/;

/** Метка текущего запроса или null — вне запроса и у браузеров без неё. */
export async function readDeviceId(): Promise<string | null> {
  try {
    const value = (await cookies()).get(DEVICE_COOKIE)?.value;
    return value && VALID.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** Метка браузера; нет — заводим. Вызывается при входе. */
export async function ensureDeviceId(): Promise<string> {
  const existing = await readDeviceId();
  if (existing) return existing;
  const id = crypto.randomBytes(12).toString("hex");
  (await cookies()).set(DEVICE_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    // Предел браузеров — 400 суток; дольше кука всё равно не проживёт.
    maxAge: 60 * 60 * 24 * 400,
  });
  return id;
}
