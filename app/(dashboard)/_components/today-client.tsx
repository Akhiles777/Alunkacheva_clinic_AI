"use client";

import { useEffect, useState } from "react";
import { CabinetCard } from "./cabinet-card";
import { FreeWindows } from "./free-windows";
import { AttentionList, InquiryList } from "./today-lists";
import { TodayAlerts } from "./today-alerts";
import { SearchTrigger } from "./command-palette";
import { BookingButton } from "./booking-panel";
import { getToday } from "@/app/_data/today";
import { useDb } from "@/app/_data/store";
import { ROOM_SOURCE_LABEL } from "@/lib/rooms";
import { formatMoney, formatNumber } from "@/lib/format";
import { formatMinute } from "@/lib/metrics/occupancy";
import { buildCabinets, buildFreeWindows, dateLabelInTz, nowMinuteInTz } from "@/lib/schedule";

/**
 * «Сегодня» из ЕДИНОГО источника — стора db.appointments (как страница
 * «Расписание»). Кабинеты, свободные окна и «сейчас» считаются из тех же данных,
 * а не из отдельного хардкода. Время — реальное, в таймзоне клиники.
 * Сводка/обращения/«требует внимания» пока из мок-агрегата getToday().
 */
export function TodayClient() {
  const db = useDb();
  const data = getToday();

  // «Сейчас» зависит от текущего времени, поэтому вычисляем ПОСЛЕ монтирования —
  // иначе SSR и клиент рендерят разную минуту и рушат гидрацию. Начальное
  // значение детерминировано (начало дня) и одинаково на сервере и клиенте.
  const [nowMinute, setNowMinute] = useState(9 * 60);
  useEffect(() => {
    const update = () => setNowMinute(nowMinuteInTz());
    const raf = requestAnimationFrame(update); // не синхронно в теле эффекта
    const t = setInterval(update, 30_000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(t);
    };
  }, []);
  const date = dateLabelInTz();
  const cabinets = buildCabinets(db.appointments, nowMinute);
  const freeWindows = buildFreeWindows(db.appointments, nowMinute);

  const scheduled = db.appointments.length;
  const firstVisits = db.appointments.filter((a) => a.isFirstVisit).length;

  return (
    <div className="text-scale-compact contents">
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
            <b className="num text-text font-medium whitespace-nowrap">{formatMoney(data.summary.revenue)}</b>
          </span>
          <span aria-hidden className="sep-dot" />
          <span>
            средний чек{" "}
            <b className="num text-text font-medium whitespace-nowrap">{formatMoney(data.summary.avgCheck)}</b>
          </span>
          <span aria-hidden className="sep-dot" />
          <span>
            <b className="num text-text font-medium">{formatNumber(scheduled)}</b> записей
          </span>
          <span aria-hidden className="sep-dot" />
          <span>
            <b className="num text-text font-medium">{formatNumber(firstVisits)}</b> первичных
          </span>
          <span className="num text-text ml-auto font-medium">{formatMinute(nowMinute)}</span>
        </div>
      </header>

      <div className="flex-1 overflow-auto px-7 pt-6 pb-11 max-md:px-5">
        <div className="mb-6">
          <TodayAlerts />
        </div>
        <div className="grid grid-cols-3 gap-4 max-lg:grid-cols-1">
          {cabinets.map((cabinet) => (
            <CabinetCard key={cabinet.id} cabinet={cabinet} />
          ))}
        </div>

        <section className="mt-[26px]">
          <div className="mb-[13px] flex items-baseline gap-2.5">
            <h2 className="text-base font-medium">Ближайшие свободные окна</h2>
            <span className="text-text-subtle text-xs">по всем кабинетам, до конца дня</span>
          </div>
          <FreeWindows windows={freeWindows} />
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
    </div>
  );
}
