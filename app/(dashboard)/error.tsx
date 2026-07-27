"use client";

/**
 * Ошибка: объясняем, что не прочиталось и что делать. Без извинений, без
 * подмены всего экрана — заголовок остаётся.
 */
export default function TodayError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="px-7 py-8 max-md:px-5">
      <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">Сегодня</h1>

      <div className="border-border bg-surface mt-7 max-w-[560px] rounded-xl border p-5">
        <p className="text-md font-medium">Данные смены не загрузились</p>
        <p className="text-text-muted mt-2 text-sm leading-relaxed">
          Экран читает локальную проекцию YCLIENTS. Записи и деньги в самом
          YCLIENTS не пострадали. Если повтор не помогает — проверьте воркер
          синхронизации и подключение к базе.
        </p>
        {error.digest ? (
          <p className="num text-text-subtle mt-3 text-xs">код ошибки {error.digest}</p>
        ) : null}
        <button
          type="button"
          onClick={reset}
          className="bg-accent text-accent-contrast hover:bg-accent-hover mt-5 rounded-md px-4 py-2 text-sm font-medium"
        >
          Загрузить снова
        </button>
      </div>
    </div>
  );
}
