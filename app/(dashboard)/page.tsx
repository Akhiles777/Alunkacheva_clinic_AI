import { CabinetCard } from "./_components/cabinet-card";
import { FreeWindows } from "./_components/free-windows";
import { AttentionList, InquiryList } from "./_components/today-lists";
import { SearchTrigger } from "./_components/command-palette";
import { BookingButton } from "./_components/booking-panel";
import { getToday } from "@/app/_data/today";
import { ROOM_SOURCE_LABEL } from "@/lib/rooms";
import { formatMoney, formatNumber } from "@/lib/format";

export const metadata = { title: "Сегодня — Мера" };

const WEEKDAY = new Intl.DateTimeFormat("ru-RU", {
  weekday: "long",
  day: "numeric",
  month: "long",
});

export default function TodayPage() {
  const data = getToday();
  const date = WEEKDAY.format(new Date(`${data.date}T09:00:00Z`));

  return (
    <>
      {/* Шапка экрана */}
      <header className="border-border flex-none border-b px-7 py-[18px] max-md:px-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">Сегодня</h1>
            <p className="text-text-muted mt-1 text-xs">{date} · смена Ирины</p>
          </div>
          <div className="flex items-center gap-3">
            <SearchTrigger className="w-[260px] max-md:hidden" />
            <BookingButton />
          </div>
        </div>
        <div className="text-text-muted mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
          <span>
            Выручка{" "}
            <b className="num text-text font-medium whitespace-nowrap">
              {formatMoney(data.summary.revenue)}
            </b>
          </span>
          <span aria-hidden className="sep-dot" />
          <span>
            средний чек{" "}
            <b className="num text-text font-medium whitespace-nowrap">
              {formatMoney(data.summary.avgCheck)}
            </b>
          </span>
          <span aria-hidden className="sep-dot" />
          <span>
            <b className="num text-text font-medium">{formatNumber(data.summary.scheduled)}</b>{" "}
            записей
          </span>
          <span aria-hidden className="sep-dot" />
          <span>
            <b className="num text-text font-medium">{formatNumber(data.summary.firstVisits)}</b>{" "}
            первичных
          </span>
          <span className="num text-text ml-auto font-medium">{data.summary.now}</span>
        </div>
      </header>

      {/* Прокручиваемая рабочая область */}
      <div className="flex-1 overflow-auto px-7 pt-6 pb-11 max-md:px-5">
        <div className="grid grid-cols-3 gap-4 max-lg:grid-cols-1">
          {data.cabinets.map((cabinet) => (
            <CabinetCard key={cabinet.id} cabinet={cabinet} />
          ))}
        </div>

        <section className="mt-[26px]">
          <div className="mb-[13px] flex items-baseline gap-2.5">
            <h2 className="text-base font-medium">Ближайшие свободные окна</h2>
            <span className="text-text-subtle text-xs">по всем кабинетам, до конца дня</span>
          </div>
          <FreeWindows windows={data.freeWindows} />
        </section>

        <div className="mt-8 grid grid-cols-2 gap-x-8 gap-y-6 max-lg:grid-cols-1">
          <section>
            <div className="mb-3.5 flex items-baseline justify-between">
              <h2 className="text-base font-medium">Требует внимания</h2>
              <span className="num text-text-subtle text-xs">{data.attention.length}</span>
            </div>
            <AttentionList items={data.attention} />
          </section>
          <section>
            <div className="mb-3.5 flex items-baseline justify-between">
              <h2 className="text-base font-medium">Новые обращения</h2>
              <span className="num text-text-subtle text-xs">{data.inquiries.length}</span>
            </div>
            <InquiryList items={data.inquiries} />
          </section>
        </div>

        <p className="text-text-subtle mt-8 text-2xs">
          Проекция YCLIENTS · кабинет визита берётся через {ROOM_SOURCE_LABEL[data.roomSource]}
        </p>
      </div>
    </>
  );
}
