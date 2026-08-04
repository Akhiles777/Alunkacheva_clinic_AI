"use client";

import Link from "next/link";

/**
 * Ошибка внутри рабочей области.
 *
 * Текст нарочно нейтральный: этот экран показывается на любой странице
 * дашборда. Раньше он был написан под «Сегодня» и на ошибке в настройках
 * рассказывал про смену и синхронизацию YCLIENTS — человек искал проблему не
 * там, где она есть.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="px-7 py-8 max-md:px-5">
      <div className="border-border bg-surface max-w-[560px] rounded-xl border p-5">
        <p className="text-md font-medium">Не удалось выполнить действие</p>
        <p className="text-text-muted mt-2 text-sm leading-relaxed">
          Страница осталась на месте, данные клиники не пострадали. Попробуйте
          повторить: чаще всего помогает. Если ошибка повторяется — сообщите код
          ниже, по нему видно, что именно произошло.
        </p>
        {error.digest ? (
          <p className="num text-text-subtle mt-3 text-xs">код ошибки {error.digest}</p>
        ) : null}
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={reset}
            className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-4 py-2 text-sm font-medium"
          >
            Повторить
          </button>
          <Link
            href="/"
            className="border-border text-text-muted hover:bg-hover rounded-md border px-4 py-2 text-sm"
          >
            На главную
          </Link>
        </div>
      </div>
    </div>
  );
}
