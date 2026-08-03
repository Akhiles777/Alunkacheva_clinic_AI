"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { isSelfRegistrationOpen, registerUser } from "../actions";
import type { AppRole } from "@/lib/roles";

function destFor(role: AppRole): string {
  return role === "owner" ? "/owner" : role === "doctor" ? "/doctor" : "/";
}

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<boolean | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let alive = true;
    isSelfRegistrationOpen()
      .then((v) => alive && setOpen(v))
      .catch(() => alive && setOpen(false));
    return () => {
      alive = false;
    };
  }, []);

  function submit() {
    setError(null);
    start(async () => {
      const res = await registerUser({ name, email, password });
      if (res.ok && res.role) {
        router.replace(destFor(res.role));
      } else {
        setError(res.error ?? "Не удалось зарегистрироваться");
      }
    });
  }

  if (open === false) {
    return (
      <div className="border-border bg-surface rounded-2xl border p-6">
        <h1 className="text-md mb-1 font-medium">Регистрация закрыта</h1>
        <p className="text-text-muted mb-5 text-sm">
          Учётные записи сотрудников заводит владелец клиники в разделе «Настройки → Сотрудники».
          Там же задаётся пароль.
        </p>
        <Link
          href="/login"
          className="bg-accent text-accent-contrast hover:bg-accent-hover block rounded-md py-2.5 text-center text-sm font-medium"
        >
          Ко входу
        </Link>
      </div>
    );
  }

  return (
    <div className="border-border bg-surface rounded-2xl border p-6">
      <h1 className="text-md mb-1 font-medium">Регистрация</h1>
      <p className="text-text-subtle mb-5 text-xs">Создайте учётную запись сотрудника.</p>

      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-text-subtle text-2xs">Имя</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Имя Фамилия"
            className="border-border-input bg-surface w-full rounded-md border px-3 py-2 text-sm outline-none"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-text-subtle text-2xs">Почта</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@mera.clinic"
            className="border-border-input bg-surface w-full rounded-md border px-3 py-2 text-sm outline-none"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-text-subtle text-2xs">Пароль</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="минимум 6 символов"
            className="border-border-input bg-surface w-full rounded-md border px-3 py-2 text-sm outline-none"
          />
        </label>

        {error ? <p className="text-accent-text text-xs">{error}</p> : null}

        <button
          type="submit"
          disabled={pending || !name.trim() || !email.trim() || password.length < 6}
          className="bg-accent text-accent-contrast hover:bg-accent-hover mt-1 rounded-md py-2.5 text-sm font-medium disabled:opacity-45"
        >
          {pending ? "Создаём…" : "Зарегистрироваться"}
        </button>
      </form>

      <p className="text-text-subtle mt-5 text-center text-xs">
        Уже есть учётная запись?{" "}
        <Link href="/login" className="text-accent-text hover:underline">
          Войти
        </Link>
      </p>
    </div>
  );
}
