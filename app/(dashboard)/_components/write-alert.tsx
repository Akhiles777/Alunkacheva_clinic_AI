"use client";

import { useEffect, useState } from "react";

/**
 * Сообщение о том, что изменение не сохранилось.
 *
 * Экран меняется сразу, база — следом; пока неудача этой второй половины
 * гасилась молча, человек видел отметку «пришёл» там, где её нет, и узнавал об
 * этом из расхождения в отчёте. Полоса внизу экрана — не украшение: она
 * закрывает разрыв между тем, что показано, и тем, что записано.
 */
export function WriteAlert() {
  const [items, setItems] = useState<{ id: number; text: string }[]>([]);

  useEffect(() => {
    let seq = 0;
    const onFail = (e: Event) => {
      const detail = (e as CustomEvent<{ action: string; reason: string }>).detail;
      if (!detail) return;
      const id = ++seq;
      setItems((prev) => [...prev.slice(-2), { id, text: detail.action }]);
      // Через полминуты убираем: сообщение напоминает проверить, а не висит вечно.
      setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== id)), 30_000);
    };
    window.addEventListener("clinic:write-failed", onFail);
    return () => window.removeEventListener("clinic:write-failed", onFail);
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4">
      {items.map((it) => (
        <div
          key={it.id}
          role="status"
          className="border-accent-border bg-accent-tint text-accent-text pointer-events-auto max-w-[520px] rounded-lg border px-4 py-2.5 text-sm shadow-sm"
        >
          {it.text}. Изменение не записано — повторите действие.
        </div>
      ))}
    </div>
  );
}
