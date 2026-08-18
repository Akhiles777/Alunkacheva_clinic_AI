"use client";

import { useEffect, useMemo, useState } from "react";
import { CabinetCard } from "./cabinet-card";
import { FreeWindows } from "./free-windows";
import { AttentionList, InquiryList } from "./today-lists";
import { TodayAlerts } from "./today-alerts";
import { SearchTrigger } from "./command-palette";
import { BookingButton } from "./booking-panel";
import type { AttentionItem } from "@/app/_data/today";
import { allCourses, useDb } from "@/app/_data/store";
import { CHANNEL_LABEL } from "@/app/_data/inbox";
import { formatMoney, formatMoneyPrecise, formatNumber } from "@/lib/format";
import { averageCheck, noShowRate } from "@/lib/metrics/summary";
import { formatMinute } from "@/lib/metrics/occupancy";
import { buildCabinets, buildFreeWindows, dateLabelInTz, nowMinuteInTz } from "@/lib/schedule";
import { getClinicDayToday, type ClinicDayView } from "../schedule/actions";

/**
 * «Сегодня» из ЕДИНОГО источника — стора db.appointments (как страница
 * «Расписание»). Кабинеты, свободные окна и «сейчас» считаются из тех же данных,
 * а не из отдельного хардкода. Время — реальное, в таймзоне клиники.
 * Сводка, обращения и «требует внимания» считаются из общего стора — то есть
 * из настоящих визитов и диалогов. Раньше здесь стоял мок-агрегат: на главном
 * экране светилась выдуманная выручка и обращения от людей, которых в клинике
 * нет.
 */
export function TodayClient() {
  const db = useDb();

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
  // Исключения расписания (праздник, санитарный день) приходят с сервера:
  // они меняют и полосу кабинетов, и список свободных окон.
  const [clinicDay, setClinicDay] = useState<ClinicDayView | null>(null);
  useEffect(() => {
    getClinicDayToday().then(setClinicDay).catch(() => {});
  }, []);

  const date = dateLabelInTz();
  // Рабочее окно дня — с учётом исключений: в праздник свободных окон нет.
  const day = clinicDay && !clinicDay.closed
    ? { startMinute: clinicDay.startMinute, endMinute: clinicDay.endMinute }
    : undefined;
  // Кабинеты — из базы клиники: они приходят вместе с рабочим днём.
  const cabinets = buildCabinets(db.appointments, nowMinute, day, clinicDay?.rooms);
  const freeWindows = clinicDay?.closed
    ? []
    : buildFreeWindows(db.appointments, nowMinute, day, clinicDay?.rooms);

  /**
   * Итоги дня.
   *
   * Заказчик смотрел на этот экран и не понимал, за какой период он: чисел, по
   * которым это видно, здесь просто не было — выручка, средний чек и «записей»
   * одинаково выглядят и за день, и за неделю. Данные всегда были дневные
   * (стор берёт визиты от полуночи клиники до полуночи), но сказать это должен
   * экран, а не исходники.
   *
   * Определения — те же, что в отчётах (§8): пришедшие — ARRIVED, первичные —
   * первый визит пациента со статусом «пришёл», повторные — все остальные
   * пришедшие. Иначе у клиники снова появятся две правды.
   */
  const scheduled = db.appointments.length;
  const arrived = db.appointments.filter((a) => a.status === "arrived");
  const noShow = db.appointments.filter((a) => a.status === "no_show");
  const ahead = db.appointments.filter((a) => a.status === "planned" || a.status === "confirmed");

  const revenue = arrived.reduce((sum, a) => sum + (a.price ?? 0), 0);
  const avgCheck = averageCheck(revenue, arrived.length);

  // Первичные и повторные — среди ПРИШЕДШИХ, как в отчётах.
  const firstVisits = arrived.filter((a) => a.isFirstVisit).length;
  const repeatVisits = arrived.length - firstVisits;
  /**
   * Доходимость: пришли ÷ (пришли + неявки).
   *
   * Знаменатель — только состоявшиеся исходы, той же функцией, что считает
   * неявки в кабинете владельца и в карточке специалиста. Запланированный на
   * вечер приём ещё не мог стать неявкой и показатель разбавлять не должен.
   */
  const settled = arrived.length + noShow.length;
  const arrivalPct = settled > 0 ? 100 - noShowRate(arrived.length, noShow.length) : null;

  // «Требует внимания» и «обращения» — из живых диалогов.
  const attention = useMemo(() => {
    const items: AttentionItem[] = [];
    const escalated = db.dialogs.filter((d) => d.status === "escalated");
    for (const d of escalated) {
      items.push({
        id: `esc-${d.id}`,
        kind: "escalation",
        title: `${d.name} — нужен человек`,
        detail: d.escalationReason ? `Агент передал: ${d.escalationReason}` : "Агент передал диалог",
        waiting: d.at,
        urgent: true,
      });
    }
    const waiting = db.dialogs.filter((d) => d.unread && d.status !== "escalated" && d.status !== "closed");
    for (const d of waiting) {
      items.push({
        id: `wait-${d.id}`,
        kind: "unanswered",
        title: `${d.name} ждёт ответа`,
        detail: `${CHANNEL_LABEL[d.channel]} · ${d.preview.slice(0, 60)}`,
        waiting: d.at,
        urgent: false,
      });
    }
    const stalled = allCourses(db.patients).filter((c) => c.stalled);
    if (stalled.length > 0) {
      const worst = stalled.reduce((a, b) => ((a.daysAgo ?? 0) > (b.daysAgo ?? 0) ? a : b));
      items.push({
        id: "stalled",
        kind: "stalled_course",
        title: `${stalled.length} курс(ов) без следующей записи`,
        detail: `Дольше всех не ходит ${worst.patientName} — сеанс ${worst.used} из ${worst.total}`,
        waiting: worst.daysAgo !== null ? `${worst.daysAgo} дн.` : "давно",
        urgent: false,
      });
    }
    return items;
  }, [db.dialogs, db.patients]);

  const inquiries = useMemo(
    () =>
      db.dialogs
        .filter((d) => d.status !== "closed")
        .slice(0, 6)
        .map((d) => ({
          id: d.id,
          name: d.name,
          channel: d.channel,
          preview: d.preview,
          at: d.at,
          isNewPatient: d.patientId === null,
        })),
    [db.dialogs],
  );

  return (
    <div className="text-scale-compact contents">
      <header className="border-border flex-none border-b px-7 py-[18px] max-md:px-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">Сегодня</h1>
            <p className="text-text-muted mt-1 text-xs">
              {date}
              {clinicDay?.closed ? (
                <span className="text-accent-text ml-2 font-medium">
                  клиника не работает{clinicDay.label ? ` · ${clinicDay.label}` : ""}
                </span>
              ) : clinicDay && clinicDay.label ? (
                <span className="text-accent-text ml-2">
                  {clinicDay.label} · до {formatMinute(clinicDay.endMinute)}
                </span>
              ) : null}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <SearchTrigger className="w-[260px] max-md:hidden" />
            <BookingButton />
          </div>
        </div>
        {/*
          Итоги дня. Раньше здесь стояли выручка, средний чек и «записей» — по
          ним нельзя понять ни за какой период экран, ни как прошёл день.
          Заказчику нужно другое: сколько пришло, сколько первичных и повторных
          и какая доходимость. Подпись «за сегодня» обязательна: одинаковые
          слова с разными числами на соседних экранах читаются как ошибка.
        */}
        <div className="text-text-muted mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
          <span className="text-text-subtle">за сегодня:</span>
          <span>
            выручка{" "}
            <b className="num text-text font-medium whitespace-nowrap">{formatMoney(revenue)}</b>
          </span>
          <span aria-hidden className="sep-dot" />
          <span>
            средний чек{" "}
            <b className="num text-text font-medium whitespace-nowrap">
              {formatMoneyPrecise(avgCheck)}
            </b>
          </span>
          <span aria-hidden className="sep-dot" />
          <span>
            пришли <b className="num text-text font-medium">{formatNumber(arrived.length)}</b>
            <span className="text-text-subtle"> из {formatNumber(scheduled)}</span>
          </span>
          <span aria-hidden className="sep-dot" />
          <span>
            первичных <b className="num text-text font-medium">{formatNumber(firstVisits)}</b>
          </span>
          <span aria-hidden className="sep-dot" />
          <span>
            повторных <b className="num text-text font-medium">{formatNumber(repeatVisits)}</b>
          </span>
          {noShow.length > 0 ? (
            <>
              <span aria-hidden className="sep-dot" />
              <span>
                неявок <b className="num text-accent-text font-medium">{formatNumber(noShow.length)}</b>
              </span>
            </>
          ) : null}
          {arrivalPct !== null ? (
            <>
              <span aria-hidden className="sep-dot" />
              <span title="пришли ÷ (пришли + неявки); запланированное на вечер в счёт не идёт">
                доходимость <b className="num text-text font-medium">{arrivalPct}%</b>
              </span>
            </>
          ) : null}
          {ahead.length > 0 ? (
            <>
              <span aria-hidden className="sep-dot" />
              {/*
                Только количество. «Из них первичных» здесь показывать нельзя:
                первичность ставится по факту прихода (§8), у ещё не
                состоявшегося визита её нет — получился бы вечный ноль,
                неотличимый от настоящего.
              */}
              <span className="text-text-subtle">впереди {formatNumber(ahead.length)}</span>
            </>
          ) : null}
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
              <span className="num text-text-subtle text-xs">{attention.length}</span>
            </div>
            <AttentionList items={attention} />
          </section>
          <section>
            <div className="mb-3.5 flex items-baseline justify-between">
              <h2 className="text-base font-medium">Новые обращения</h2>
              <span className="num text-text-subtle text-xs">{inquiries.length}</span>
            </div>
            <InquiryList items={inquiries} />
          </section>
        </div>

        {/*
          Здесь стояла строка «кабинет визита берётся через маппинг
          «специалист → кабинет»» — по флагу окружения, которого в браузере
          нет вовсе, поэтому она всегда называла один и тот же источник.
          Выгрузка ищет кабинет иначе: ресурс YCLIENTS, потом кабинет
          специалиста, потом кабинет услуги. Подпись под данными не должна
          говорить о них неправду.
        */}
        <p className="text-text-subtle mt-8 text-2xs">
          Проекция YCLIENTS · кабинет визита — из ресурса записи, кабинета специалиста или кабинета
          услуги; если ничего из этого не задано, визит остаётся без кабинета
        </p>
      </div>
    </div>
  );
}
