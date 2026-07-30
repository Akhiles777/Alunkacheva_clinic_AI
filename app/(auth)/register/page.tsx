"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { registerUser } from "../actions";
import { setRole } from "@/app/_data/role";

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit() {
    setError(null);
    start(async () => {
      const res = await registerUser({ name, email, password });
      if (res.ok) {
        setRole("admin");
        router.replace("/");
      } else {
        setError(res.error ?? "Не удалось зарегистрироваться");
      }
    });
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
