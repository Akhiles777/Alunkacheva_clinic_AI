"use client";

/**
 * Ошибка чтения метрик. Панель не подменяется целиком: на месте секции
 * появляется вставка с текстом ошибки и кнопкой повтора (DESIGN.md §6).
 * Текст об ошибке набран signal-ink — сигнальный тон на 6,9:1, а не заливкой.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section>
      <header className="border-groove border-b px-4 py-2">
        <h2 className="legend">Метрики клиники</h2>
      </header>
      <div className="px-4 py-4">
        <div className="bg-inset border-groove border px-4 py-3">
          <p className="text-signal-ink text-[13px] font-medium">
            Показания не прочитаны: роллапы недоступны.
          </p>
          <p className="text-label mt-1 text-[12px]">
            Дашборд читает локальную проекцию YCLIENTS. Если ошибка повторяется —
            проверьте воркер пересчёта и подключение к базе.
          </p>
          {error.digest ? (
            <p className="num text-label mt-2 text-[11px]">код {error.digest}</p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            className="legend border-groove bg-panel-sunk hover:bg-inset relative mt-3 border px-3 py-1.5"
          >
            Повторить
            <span aria-hidden className="bg-signal absolute inset-x-0 bottom-0 h-0.5" />
          </button>
        </div>
      </div>
    </section>
  );
}
