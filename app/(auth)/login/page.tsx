"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { loginAsOwner, loginUser } from "../actions";
import type { AppRole } from "@/lib/roles";

function destFor(role: AppRole): string {
  return role === "owner" ? "/owner" : role === "doctor" ? "/doctor" : "/";
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function enter(role: AppRole) {
    router.replace(destFor(role));
  }

  function submit() {
    setError(null);
    start(async () => {
      const res = await loginUser({ email, password });
      if (res.ok && res.role) enter(res.role);
      else setError(res.error ?? "Не удалось войти");
    });
  }

  function ownerBypass() {
    setError(null);
    start(async () => {
      const res = await loginAsOwner();
      if (res.ok) enter("owner");
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
            placeholder="••••••"
            className="border-border-input bg-surface w-full rounded-md border px-3 py-2 text-sm outline-none"
          />
        </label>

        {error ? <p className="text-accent-text text-xs">{error}</p> : null}

        <button
          type="submit"
          disabled={pending || !email.trim() || !password}
          className="bg-accent text-accent-contrast hover:bg-accent-hover mt-1 rounded-md py-2.5 text-sm font-medium disabled:opacity-45"
        >
          {pending ? "Входим…" : "Войти"}
        </button>
      </form>

      <div className="my-4 flex items-center gap-3">
        <span className="border-border-soft h-px flex-1 border-t" />
        <span className="text-text-subtle text-2xs">или</span>
        <span className="border-border-soft h-px flex-1 border-t" />
      </div>

      <button
        type="button"
        onClick={ownerBypass}
        disabled={pending}
        className="border-accent-border bg-accent-tint text-accent-text hover:bg-accent hover:text-accent-contrast w-full rounded-md border py-2.5 text-sm font-medium disabled:opacity-45"
      >
        Войти как владелец
      </button>

      <p className="text-text-subtle mt-5 text-center text-xs">
        Нет учётной записи?{" "}
        <Link href="/register" className="text-accent-text hover:underline">
          Зарегистрироваться
        </Link>
      </p>
    </div>
  );
}
