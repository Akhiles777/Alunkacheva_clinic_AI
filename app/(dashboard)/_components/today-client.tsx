"use client";

import { useEffect, useMemo, useState } from "react";
import { CabinetCard } from "./cabinet-card";
import { DayPicker } from "./day-picker";
import { RevenueBreakdown } from "./revenue-breakdown";
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
import { getClinicDay, getAppointmentsForDay, type ClinicDayView } from "../schedule/actions";
import { getCourseSalesForDay, type CourseSaleRow } from "../courses/actions";
import { clinicDateKey } from "@/lib/clinic-time";

/**
 * «Сегодня» из ЕДИНОГО источника — стора db.appointments (как страница
 * «Расписание»). Кабинеты, свободные окна и «сейчас» считаются из тех же данных,
 * а не из отдельного хардкода. Время — реальное, в таймзоне клиники.
 * Сводка, обращения и «требует внимания» считаются из общего стора — то есть
 * из настоящих визитов и диалогов. Раньше здесь стоял мок-агрегат: на главном
 * экране светилась выдуманная выручка и обращения от людей, которых в клинике
 * нет.
 */
/** Насколько далеко назад можно листать: дальше — «Отчёты» и «Аналитика». */
const MAX_DAYS_BACK = 30;

/** «18 августа» — короткая подпись дня для строки итогов. */
function dayLabelShort(at: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "numeric",
    month: "long",
  }).format(at);
}

/** Ключ дня «столько-то суток назад» от заданного момента, в поясе клиники. */
function dayKeyBack(fromMs: number, back: number): string {
  return clinicDateKey(new Date(fromMs - back * 24 * 3600 * 1000));
}

export function TodayClient() {
  const db = useDb();

  // «Сейчас» зависит от текущего времени, поэтому вычисляем ПОСЛЕ монтирования —
  // иначе SSR и клиент рендерят разную минуту и рушат гидрацию. Начальное
  // значение детерминировано (начало дня) и одинаково на сервере и клиенте.
  const [nowMinute, setNowMinute] = useState(9 * 60);
  /**
   * Момент «сейчас», зафиксированный после монтирования.
   *
   * От него отсчитываются прошедшие дни. Спрашивать время прямо в теле
   * компонента нельзя: рендер обязан быть предсказуемым, а `Date.now()` на
   * каждом проходе даёт новый ответ — при перерисовке экран мог бы уехать на
   * другой день.
   */
  const [todayMs, setTodayMs] = useState<number | null>(null);
  useEffect(() => {
    const update = () => {
      setNowMinute(nowMinuteInTz());
      setTodayMs(Date.now());
    };
    const raf = requestAnimationFrame(update); // не синхронно в теле эффекта
    const t = setInterval(update, 30_000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(t);
    };
  }, []);
  /**
   * Какой день показан: 0 — сегодня, дальше — назад по суткам.
   *
   * «Сегодня» отвечал только на вопрос «как идёт день», а «как прошёл вчерашний»
   * приходилось искать в отчётах — другим экраном, с другими подписями и другим
   * периодом. Один и тот же вопрос не должен требовать двух разных мест.
   *
   * Сегодняшний день берём из общего стора: он и так обновляется сам каждую
   * минуту. Прошедшие читаем с сервера по требованию — держать их в сторе
   * незачем, они не меняются.
   */
  /** Открыт ли разбор выручки: «из чего сложилось» по нажатию на сумму. */
  const [showOperations, setShowOperations] = useState(false);
  const [dayBack, setDayBack] = useState(0);
  const [dir, setDir] = useState<"back" | "fwd">("back");
  /**
   * Загруженный день лежит вместе со своим ключом.
   *
   * Иначе при быстром листании на экран попадали числа предыдущего запроса:
   * ответы приходят не в том порядке, в каком уходили. Ключ отвечает на
   * вопрос «эти данные точно про тот день, который показан».
   */
  const [loaded, setLoaded] = useState<{ key: string; rows: typeof db.appointments } | null>(null);
  /**
   * Курсы, проданные в показанный день.
   *
   * Деньги за курс приходят в день покупки — это выручка того дня наравне со
   * стоимостью приёмов. Без них экран показывал день беднее, чем он был.
   */
  const [sales, setSales] = useState<{ key: string; rows: CourseSaleRow[] } | null>(null);

  useEffect(() => {
    if (todayMs === null) return;
    const key = dayKeyBack(todayMs, dayBack);
    let alive = true;
    getCourseSalesForDay(key)
      .then((rows) => {
        if (alive) setSales({ key, rows });
      })
      .catch(() => {
        if (alive) setSales({ key, rows: [] });
      });
    return () => {
      alive = false;
    };
  }, [dayBack, todayMs]);

  useEffect(() => {
    if (dayBack === 0 || todayMs === null) return;
    const key = dayKeyBack(todayMs, dayBack);
    let alive = true;
    getAppointmentsForDay(key)
      .then((rows) => {
        if (alive) setLoaded({ key, rows });
      })
      .catch(() => {
        // Пустой день и несостоявшееся чтение выглядят одинаково. Показать
        // пустой день честнее, чем оставить на экране числа другого.
        if (alive) setLoaded({ key, rows: [] });
      });
    return () => {
      alive = false;
    };
  }, [dayBack, todayMs]);

  const goBack = () => {
    setDir("back");
    setDayBack((d) => Math.min(MAX_DAYS_BACK, d + 1));
  };
  const goForward = () => {
    setDir("fwd");
    setDayBack((d) => Math.max(0, d - 1));
  };
  const goToday = () => {
    setDir("fwd");
    setDayBack(0);
  };
  /**
   * Выбор дня датой. Считаем смещение от сегодняшнего дня клиники, а не от
   * полуночи браузера: на телефоне в другом поясе иначе открывался бы соседний
   * день.
   */
  const pickDay = (value: string) => {
    if (todayMs === null || !value) return;
    for (let back = 0; back <= MAX_DAYS_BACK; back += 1) {
      if (dayKeyBack(todayMs, back) === value) {
        setDir(back > dayBack ? "back" : "fwd");
        setDayBack(back);
        return;
      }
    }
  };

  // Исключения расписания (праздник, санитарный день) приходят с сервера:
  // они меняют и полосу кабинетов, и список свободных окон.
  const [clinicDay, setClinicDay] = useState<ClinicDayView | null>(null);
  useEffect(() => {
    let alive = true;
    // График дня — того дня, который показан: у субботы своё окно, а в
    // праздник клиника закрыта. Подставлять сюда сегодняшнее окно нельзя.
    getClinicDay(dayBack === 0 || todayMs === null ? undefined : dayKeyBack(todayMs, dayBack))
      .then((d) => {
        if (alive) setClinicDay(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [dayBack, todayMs]);

  const isToday = dayBack === 0;
  const wantKey = isToday || todayMs === null ? null : dayKeyBack(todayMs, dayBack);
  const pastAppts = loaded !== null && loaded.key === wantKey ? loaded.rows : null;
  /** День ещё едет с сервера — приглушаем, а не мигаем пустотой. */
  const dayPending = !isToday && pastAppts === null;
  /** Визиты показанного дня: сегодняшние из стора, прошедшие — с сервера. */
  const appts = isToday ? db.appointments : (pastAppts ?? []);
  const shownAt = new Date((todayMs ?? 0) - dayBack * 24 * 3600 * 1000);
  const date = isToday ? dateLabelInTz() : dateLabelInTz("Europe/Moscow", shownAt);
  // Рабочее окно дня — с учётом исключений: в праздник свободных окон нет.
  const day = clinicDay && !clinicDay.closed
    ? { startMinute: clinicDay.startMinute, endMinute: clinicDay.endMinute }
    : undefined;
  // Кабинеты — из базы клиники: они приходят вместе с рабочим днём.
  /**
   * Для прошедшего дня «сейчас» — его конец: полоса показывает день целиком,
   * а не обрубок до текущей минуты. Метка «сейчас» на вчерашней полосе —
   * неправда о том дне.
   */
  const stripMinute = isToday ? nowMinute : (day?.endMinute ?? 24 * 60);
  const cabinets = buildCabinets(appts, stripMinute, day, clinicDay?.rooms);
  // Свободные окна — вопрос про «куда записать», он есть только у сегодня.
  const freeWindows =
    !isToday || clinicDay?.closed ? [] : buildFreeWindows(appts, nowMinute, day, clinicDay?.rooms);

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
  const scheduled = appts.length;
  const arrived = appts.filter((a) => a.status === "arrived");
  const noShow = appts.filter((a) => a.status === "no_show");
  const ahead = isToday
    ? appts.filter((a) => a.status === "planned" || a.status === "confirmed")
    : [];

  /**
   * Выручка дня: стоимость состоявшихся приёмов плюс проданные курсы.
   *
   * Курс пробивают кассой, а не приёмом, и его деньги приходят в день продажи.
   *
   * Средний чек делим на оплаченные чеки — приёмы с суммой плюс продажи
   * курсов. Сеанс курса и бесплатный приём не считаются: в день из десяти
   * приёмов, где восемь — курсовые сеансы по нулю и один бесплатный,
   * «выручка ÷ пришедшие» давала 300 ₽ вместо трёх тысяч заплатившего.
   */
  const shownKey = todayMs === null ? null : dayKeyBack(todayMs, dayBack);
  const daySales = sales !== null && sales.key === shownKey ? sales.rows : [];
  const visitsRevenue = arrived.reduce((sum, a) => sum + (a.price ?? 0), 0);
  const coursesRevenue = daySales.reduce((sum, s) => sum + s.amount, 0);
  const revenue = visitsRevenue + coursesRevenue;
  const paidVisits = arrived.filter((a) => (a.price ?? 0) > 0).length;
  const avgCheck = averageCheck(revenue, paidVisits + daySales.length);

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
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">
                {isToday ? "Сегодня" : "День"}
              </h1>
              {/*
                Листалка дней. «Сегодня» отвечал только на вопрос «как идёт
                день», а «как прошёл вчерашний» приходилось искать в отчётах —
                другим экраном и с другими подписями. Один вопрос не должен
                требовать двух разных мест.
              */}
              <div className="border-border bg-bg flex items-center gap-0.5 rounded-full border p-0.5">
                <button
                  type="button"
                  onClick={goBack}
                  disabled={dayBack >= MAX_DAYS_BACK}
                  aria-label="Предыдущий день"
                  className="text-text-muted hover:bg-list-gap hover:text-text flex size-6 items-center justify-center rounded-full transition-colors disabled:pointer-events-none disabled:opacity-35"
                >
                  ‹
                </button>
                {/*
                  Календарь, а не только шаг стрелкой: чтобы попасть на день
                  двухнедельной давности, стрелку пришлось бы нажать
                  четырнадцать раз.
                */}
                {todayMs === null ? (
                  <span className="text-text-subtle px-2.5 py-1 text-xs">…</span>
                ) : (
                  <DayPicker
                    value={dayKeyBack(todayMs, dayBack)}
                    min={dayKeyBack(todayMs, MAX_DAYS_BACK)}
                    max={dayKeyBack(todayMs, 0)}
                    label={dayLabelShort(shownAt)}
                    onPick={pickDay}
                  />
                )}
                <button
                  type="button"
                  onClick={goForward}
                  disabled={isToday}
                  aria-label="Следующий день"
                  className="text-text-muted hover:bg-list-gap hover:text-text flex size-6 items-center justify-center rounded-full transition-colors disabled:pointer-events-none disabled:opacity-35"
                >
                  ›
                </button>
              </div>
              {!isToday ? (
                <button
                  type="button"
                  onClick={goToday}
                  className="text-accent-text hover:bg-accent-tint rounded-full px-2 py-0.5 text-xs transition-colors"
                >
                  вернуться к сегодня
                </button>
              ) : null}
            </div>
            <p key={`d-${dayBack}`} className={`text-text-muted mt-1 text-xs day-in-${dir}`}>
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
        <div
          key={`sum-${dayBack}`}
          className={`text-text-muted mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs day-in-${dir} ${dayPending ? "day-pending" : ""}`}
        >
          <span className="text-text-subtle">{isToday ? "за сегодня:" : `за ${dayLabelShort(shownAt)}:`}</span>
          <span>
            выручка{" "}
            {/*
              Число отвечало «сколько», но не «откуда». Первый вопрос после
              «сегодня 43 480 ₽» — «из чего это», и ответ приходилось искать
              другим экраном.
            */}
            <button
              type="button"
              onClick={() => setShowOperations(true)}
              title="Показать операции дня"
              className="num text-text hover:text-accent-text font-medium whitespace-nowrap underline decoration-dotted underline-offset-2 transition-colors"
            >
              {formatMoney(revenue)}
            </button>
          </span>
          <span aria-hidden className="sep-dot" />
          <span title="Деньги дня ÷ оплаченные чеки: приёмы с суммой и проданные курсы. Сеансы курса и бесплатные приёмы не в счёт.">
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
          {isToday ? (
            <span className="num text-text ml-auto font-medium">{formatMinute(nowMinute)}</span>
          ) : (
            <span className="text-text-subtle ml-auto">день завершён</span>
          )}
        </div>
      </header>

      {showOperations ? (
        <RevenueBreakdown
          appts={appts}
          sales={daySales}
          dateLabel={isToday ? "сегодня" : dayLabelShort(shownAt)}
          onClose={() => setShowOperations(false)}
        />
      ) : null}

      <div className="flex-1 overflow-auto px-7 pt-6 pb-11 max-md:px-5">
        {/*
          Тревоги, обращения и свободные окна — про «сейчас», а не про
          показанный день. Под шапкой прошедшего дня они читались бы как его
          состояние, а это неправда: диалог ждёт ответа сегодня, а не в прошлый
          вторник.
        */}
        {isToday ? (
          <div className="mb-6">
            <TodayAlerts />
          </div>
        ) : null}
        <div key={`cab-${dayBack}`} className={`grid grid-cols-3 gap-4 max-lg:grid-cols-1 day-in-${dir} ${dayPending ? "day-pending" : ""}`}>
          {cabinets.map((cabinet) => (
            <CabinetCard key={cabinet.id} cabinet={cabinet} />
          ))}
        </div>

        {isToday ? (
          <section className="mt-[26px]">
            <div className="mb-[13px] flex items-baseline gap-2.5">
              <h2 className="text-base font-medium">Ближайшие свободные окна</h2>
              <span className="text-text-subtle text-xs">по всем кабинетам, до конца дня</span>
            </div>
            <FreeWindows windows={freeWindows} />
          </section>
        ) : null}

        <div
          className={`mt-8 grid grid-cols-2 gap-x-8 gap-y-6 max-lg:grid-cols-1 ${isToday ? "" : "hidden"}`}
        >
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
