/**
 * Экран загрузки раздела.
 *
 * Переход между разделами упирается в серверный рендер: без обратной связи
 * экран замирает на прежней странице, и по нему нельзя понять, нажалось ли
 * вообще. Показываем обычный крутящийся индикатор — понятный без объяснений.
 *
 * Шапка с названием остаётся на месте: так видно, куда идём, и содержимое не
 * прыгает, когда доедет.
 */
export function PageSkeleton({ title }: { title: string; variant?: string }) {
  return (
    <div aria-busy="true" aria-label={`Загружаем: ${title}`} className="contents">
      <header className="border-border flex-none border-b px-7 py-[18px] max-md:px-5">
        <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">{title}</h1>
      </header>
      <div className="flex flex-1 items-center justify-center">
        <Spinner label={`Загружаем ${title.toLowerCase()}`} />
      </div>
    </div>
  );
}

/**
 * Крутящийся индикатор.
 *
 * Кольцо с разрывом, вращается равномерно. При `prefers-reduced-motion`
 * вращение гасится общим правилом в globals.css, и остаётся статичное кольцо —
 * поэтому подпись рядом обязательна, иначе смысл потеряется.
 */
export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center gap-3" role="status">
      <span className="spinner" aria-hidden />
      {label ? <span className="text-text-subtle text-xs">{label}</span> : null}
      <span className="sr-only">{label ?? "Загрузка"}</span>
    </div>
  );
}
