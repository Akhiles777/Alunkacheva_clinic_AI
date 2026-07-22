/**
 * Состояние загрузки: гравировка остаётся на месте — шкала времени, деления,
 * подписи колонок. Пусты только вставки. Серых пульсирующих полосок нет:
 * панель прибора не «мерцает», она ждёт показаний (DESIGN.md §6).
 */
function ScaleSkeleton() {
  const hours = Array.from({ length: 13 }, (_, index) => 9 + index);

  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <div className="min-w-[540px]">
        <div className="grid grid-cols-[92px_minmax(0,1fr)_58px] gap-x-3 md:grid-cols-[176px_minmax(0,1fr)_96px] md:gap-x-4">
          <span className="legend self-end pb-1">канал</span>
          <div className="relative h-6">
            <span aria-hidden className="bg-groove absolute inset-x-0 bottom-0 h-px" />
            {hours.map((hour, index) => (
              <span
                key={hour}
                className="num text-label absolute bottom-2.5 text-[10px] leading-none"
                style={{
                  left: `${(index / (hours.length - 1)) * 100}%`,
                  transform:
                    index === 0
                      ? undefined
                      : index === hours.length - 1
                        ? "translateX(-100%)"
                        : "translateX(-50%)",
                }}
              >
                {String(hour).padStart(2, "0")}
              </span>
            ))}
            {hours.map((hour, index) => (
              <span
                key={`tick-${hour}`}
                aria-hidden
                className="bg-groove absolute bottom-0 h-2 w-px"
                style={{ left: `${(index / (hours.length - 1)) * 100}%` }}
              />
            ))}
          </div>
          <span className="legend self-end pb-1 text-right">занято</span>
        </div>

        <ul>
          {[0, 1, 2].map((row) => (
            <li
              key={row}
              className="border-groove grid grid-cols-[92px_minmax(0,1fr)_58px] items-center gap-x-3 border-t py-2.5 md:grid-cols-[176px_minmax(0,1fr)_96px] md:gap-x-4 md:py-3"
            >
              <span className="bg-panel-sunk idle block h-3 w-full" />
              <span className="border-groove bg-panel-sunk idle block h-14 border md:h-[60px]" />
              <span className="bg-panel-sunk idle ml-auto block h-3 w-10" />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function DashboardLoading() {
  return (
    <>
      <div className="border-groove flex items-end justify-between gap-3 border-b px-4 py-2.5">
        <div>
          <h1 className="display text-[15px] leading-tight font-semibold">Метрики клиники</h1>
          <p className="legend mt-1">чтение показаний…</p>
        </div>
        <span className="border-groove bg-panel-sunk idle h-[30px] w-[196px] border" />
      </div>

      <section>
        <header className="border-groove flex items-baseline justify-between gap-3 border-b px-4 py-2">
          <h2 className="legend">Каналы · рабочий день</h2>
        </header>
        <div className="px-4 py-3.5">
          <ScaleSkeleton />
        </div>
      </section>

      <div className="border-groove grid grid-cols-1 border-t lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        {["Воронка", "Показания"].map((title, index) => (
          <section
            key={title}
            className={index === 1 ? "border-groove border-t lg:border-t-0 lg:border-l" : undefined}
          >
            <header className="border-groove border-b px-4 py-2">
              <h2 className="legend">{title}</h2>
            </header>
            <div className="space-y-2 px-4 py-3.5">
              {[0, 1, 2].map((row) => (
                <span
                  key={row}
                  className="border-groove bg-panel-sunk idle block h-6 border"
                  style={{ width: `${100 - row * 14}%` }}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
