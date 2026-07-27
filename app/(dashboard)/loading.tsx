/**
 * Загрузка «Сегодня»: каркас экрана на месте — шапка, три карточки кабинетов,
 * список. Дышит серым, без бегущих полосок.
 */
export default function TodayLoading() {
  return (
    <div aria-busy="true" aria-label="Загружаем смену">
      <header className="border-border flex-none border-b px-7 py-[18px] max-md:px-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">Сегодня</h1>
            <div className="skeleton mt-2 h-3 w-40 rounded-sm" />
          </div>
          <div className="skeleton h-9 w-28 rounded-md" />
        </div>
        <div className="mt-3.5 flex gap-4">
          <div className="skeleton h-3 w-28 rounded-sm" />
          <div className="skeleton h-3 w-28 rounded-sm" />
          <div className="skeleton h-3 w-20 rounded-sm" />
        </div>
      </header>

      <div className="flex-1 px-7 pt-6 max-md:px-5">
        <div className="grid grid-cols-3 gap-4 max-lg:grid-cols-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className="border-border bg-surface rounded-xl border p-[18px]">
              <div className="skeleton h-4 w-28 rounded-sm" />
              <div className="skeleton mt-2 h-3 w-24 rounded-sm" />
              <div className="border-border-soft my-[15px] border-t" />
              <div className="skeleton h-4 w-40 rounded-sm" />
              <div className="skeleton mt-4 h-[70px] w-full rounded-lg" />
            </div>
          ))}
        </div>
        <div className="skeleton mt-[26px] h-4 w-52 rounded-sm" />
        <div className="skeleton mt-3 h-[260px] w-full rounded-xl" />
      </div>
    </div>
  );
}
