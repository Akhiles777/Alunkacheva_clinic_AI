/**
 * Каркас страницы на время загрузки.
 *
 * Переход между разделами упирался в серверный рендер: экран замирал на
 * прежней странице, и по нему нельзя было понять, нажалось ли вообще. Каркас
 * появляется мгновенно и держит ту же сетку, что придёт следом, — поэтому
 * содержимое не прыгает, когда доедет.
 *
 * Дышит серым (класс `skeleton`), без бегущих бликов; при
 * `prefers-reduced-motion` дыхание отключается общим правилом в globals.css.
 */
export function PageSkeleton({
  title,
  variant = "list",
}: {
  title: string;
  /** Форма содержимого: список строк, карточки-цифры или широкая полоса. */
  variant?: "list" | "cards" | "board";
}) {
  return (
    <div aria-busy="true" aria-label={`Загружаем: ${title}`} className="contents">
      <header className="border-border flex-none border-b px-7 py-[18px] max-md:px-5">
        <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">{title}</h1>
        <div className="skeleton mt-2 h-3 w-56 rounded-sm" />
      </header>

      <div className="page-enter flex-1 overflow-hidden px-7 py-6 max-md:px-5">
        {variant === "cards" ? (
          <>
            <div className="grid grid-cols-4 gap-4 max-lg:grid-cols-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="border-border bg-surface rounded-xl border p-[18px]">
                  <div className="skeleton h-3 w-24 rounded-sm" />
                  <div className="skeleton mt-3 h-6 w-28 rounded-sm" />
                </div>
              ))}
            </div>
            <div className="skeleton mt-6 h-[280px] w-full rounded-xl" />
          </>
        ) : variant === "board" ? (
          <div className="grid grid-cols-3 gap-4 max-lg:grid-cols-1">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-[420px] rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="border-border overflow-hidden rounded-xl border">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="border-border-soft flex items-center gap-3 border-b p-3.5 last:border-0">
                <div className="skeleton size-8 flex-none rounded-full" />
                <div className="min-w-0 flex-1">
                  <div className="skeleton h-3.5 w-48 rounded-sm" />
                  <div className="skeleton mt-2 h-3 w-72 max-w-full rounded-sm" />
                </div>
                <div className="skeleton h-3 w-14 flex-none rounded-sm" />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
