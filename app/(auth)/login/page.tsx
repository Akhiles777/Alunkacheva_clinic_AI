"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { loginUser } from "../actions";
import type { AppRole } from "@/lib/roles";

function destFor(role: AppRole): string {
  return role === "owner" ? "/owner" : role === "doctor" ? "/doctor" : "/";
}

export default function LoginPage() {
  const router = useRouter();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function enter(role: AppRole) {
    router.replace(destFor(role));
  }

  function submit() {
    setError(null);
    start(async () => {
      const res = await loginUser({ login, password });
      if (res.ok && res.role) enter(res.role);
      else setError(res.error ?? "Не удалось войти");
    });
  }

  return (
    <div className="border-border bg-surface rounded-2xl border p-6">
      <h1 className="text-md mb-1 font-medium">Вход</h1>
      <p className="text-text-subtle mb-5 text-xs">Войдите в кабинет клиники.</p>

      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-text-subtle text-2xs">Логин</span>
          <input
            type="text"
            autoComplete="username"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            placeholder="например, olga"
            className="border-border-input bg-surface w-full rounded-md border px-3 py-2 text-sm outline-none"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-text-subtle text-2xs">Пароль</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••"
            className="border-border-input bg-surface w-full rounded-md border px-3 py-2 text-sm outline-none"
          />
        </label>

        {error ? <p className="text-accent-text text-xs">{error}</p> : null}

        <button
          type="submit"
          disabled={pending || !login.trim() || !password}
          className="bg-accent text-accent-contrast hover:bg-accent-hover mt-1 rounded-md py-2.5 text-sm font-medium disabled:opacity-45"
        >
          {pending ? "Входим…" : "Войти"}
        </button>
      </form>

      <p className="text-text-subtle mt-5 text-center text-xs">
        Нет учётной записи?{" "}
        <Link href="/register" className="text-accent-text hover:underline">
          Зарегистрироваться
        </Link>
      </p>
    </div>
  );
}
