import type { CabinetNow } from "@/app/_data/today";

/**
 * Карточка кабинета «Сегодня». Крупным mono-числом — следующее свободное окно.
 * Ближайшее по клинике окно заливается сплошным акцентом, остальные — мягким
 * тоном. Первичный пациент помечается точкой акцента, а не цветом текста.
 */
export function CabinetCard({ cabinet }: { cabinet: CabinetNow }) {
  const free = cabinet.nextFree;

  return (
    <div className="border-border bg-surface rounded-xl border p-[18px]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-md font-medium">{cabinet.direction}</div>
          <div className="text-text-subtle mt-0.5 truncate text-xs">
            принимает {cabinet.doctor}
          </div>
        </div>
        <span className="num text-text-muted bg-chip rounded-sm px-1.5 py-0.5 text-2xs whitespace-nowrap">
          {cabinet.name}
        </span>
      </div>

      <div className="border-border-soft my-[15px] border-t" />

      <div className="text-text-subtle text-2xs">сейчас</div>
      {cabinet.current ? (
        <>
          <div className="mt-1.5 flex items-center gap-1.5">
            {cabinet.current.isFirstVisit ? (
              <span
                aria-hidden
                className="bg-accent h-1.5 w-1.5 flex-none rounded-[2px]"
                title="первичный"
              />
            ) : null}
            <span className="truncate text-base font-medium">{cabinet.current.proc}</span>
            <span className="text-text-muted truncate text-xs">· {cabinet.current.patient}</span>
          </div>
          <div className="num text-text-subtle mt-1 text-xs">занят до {cabinet.current.until}</div>
        </>
      ) : (
        <div className="mt-1.5 text-base font-medium">Свободен</div>
      )}

      {free ? (
        <div
          className={`mt-[18px] rounded-lg border p-[14px] ${
            free.soon ? "bg-accent border-accent" : "bg-accent-tint border-accent-border"
          }`}
        >
          <div
            className={`text-2xs font-medium ${free.soon ? "text-accent-contrast" : "text-accent-text"}`}
          >
            следующее свободное окно
          </div>
          <div className="mt-1.5 flex items-baseline gap-3">
            <span
              className={`num text-2xl leading-none font-medium tracking-[-0.02em] ${
                free.soon ? "text-accent-contrast" : "text-accent-text"
              }`}
            >
              {free.time}
            </span>
            <span
              className={`num text-base ${free.soon ? "text-accent-contrast" : "text-accent-text"}`}
            >
              {free.duration}
            </span>
          </div>
        </div>
      ) : (
        <div className="border-border bg-bg mt-[18px] rounded-lg border p-[14px]">
          <div className="text-text-subtle text-2xs font-medium">свободных окон нет</div>
          <div className="num text-text-muted mt-1.5 text-base">занят до конца дня</div>
        </div>
      )}
    </div>
  );
}
