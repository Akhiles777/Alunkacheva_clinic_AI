"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { formatMinute } from "@/lib/metrics/occupancy";
import { formatMoney } from "@/lib/format";
import { useDb } from "@/app/_data/store";
import { getCurrentUser, type CurrentUser } from "../_components/user-actions";
import { InternalStaffChat } from "../chat/internal-staff-chat";
import { VisitNote } from "../_components/visit-note";
import { getCourseSalesForDay, type CourseSaleRow } from "../courses/actions";
import { clinicDateKey } from "@/lib/clinic-time";

const APPT_STATUS: Record<string, string> = {
  planned: "запланирован",
  confirmed: "подтверждён",
  arrived: "пришёл",
  no_show: "не пришёл",
};

export default function DoctorPage() {
  const db = useDb();
  const [me, setMe] = useState<CurrentUser | null>(null);
  useEffect(() => {
    getCurrentUser().then(setMe).catch(() => {});
  }, []);
  const myName = me?.name ?? "";

  /**
   * Свои приёмы — по идентификатору специалиста.
   *
   * Здесь стояло сравнение имён: `a.doctor === myName`. Учётка сотрудника и
   * карточка специалиста заполняются по отдельности, и «Ирина Алункачева»
   * против «Алункачева И. Ю.» давали врачу пустой экран вместо его дня. По
   * имени отбираем только когда специалист к учётке не привязан вовсе.
   */
  const myStaffId = me?.staffId ?? null;
  const myAppts = useMemo(
    () =>
      db.appointments
        .filter((a) => (myStaffId ? a.staffId === myStaffId : a.doctor === myName))
        .sort((a, b) => a.startMinute - b.startMinute),
    [db.appointments, myStaffId, myName],
  );
  const roomName = me?.roomName ?? myAppts[0]?.roomName ?? "—";

  const arrived = myAppts.filter((a) => a.status === "arrived").length;
  const noShow = myAppts.filter((a) => a.status === "no_show").length;
  const hours = myAppts.filter((a) => a.status !== "no_show").reduce((s, a) => s + a.durationMin, 0) / 60;
  /**
   * Выручка — из данных визита, а не из зашитого прайса.
   *
   * Здесь стояло `priceOf(a.service)` — список цен по ключевым словам прямо в
   * коде: остеопатия 6500, БОС 5000. У клиники цены другие (взрослый приём
   * 8000), и врач видел выдуманные суммы, не совпадающие ни с отчётами, ни с
   * кассой. Цена визита приходит из YCLIENTS вместе с записью.
   */
  /**
   * Проданные сегодня курсы — тоже выручка врача, который их ведёт.
   *
   * Сеанс курса стоит нулём: деньги пришли при продаже. Без них у
   * БОС-терапевта на своём экране почти всегда ноль, а в отчёте по
   * специалистам — настоящая сумма. Два экрана про один день расходились (§8).
   */
  const [courseSales, setCourseSales] = useState<CourseSaleRow[]>([]);
  useEffect(() => {
    let alive = true;
    getCourseSalesForDay(clinicDateKey())
      .then((rows) => {
        if (alive) setCourseSales(rows);
      })
      .catch(() => {
        if (alive) setCourseSales([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const revenue =
    myAppts.filter((a) => a.status === "arrived").reduce((s, a) => s + (a.price ?? 0), 0) +
    courseSales
      .filter((s) => (myStaffId ? s.staffId === myStaffId : s.staffName === myName))
      .reduce((s, x) => s + x.amount, 0);

  // Уведомления — из данных: ближайшие приёмы, первичные, неявки.
  const notifications = useMemo(() => {
    const items: { id: string; text: string; urgent: boolean }[] = [];
    const upcoming = myAppts.filter((a) => a.status === "planned" || a.status === "confirmed");
    if (upcoming[0]) {
      items.push({
        id: "next",
        text: `Ближайший приём: ${formatMinute(upcoming[0].startMinute)} — ${upcoming[0].patientName}`,
        urgent: false,
      });
    }
    for (const a of myAppts.filter((x) => x.isFirstVisit)) {
      items.push({ id: `fv-${a.id}`, text: `Первичный пациент: ${a.patientName} в ${formatMinute(a.startMinute)}`, urgent: false });
    }
    for (const a of myAppts.filter((x) => x.status === "no_show")) {
      items.push({ id: `ns-${a.id}`, text: `Не пришёл: ${a.patientName} (${formatMinute(a.startMinute)})`, urgent: true });
    }
    if (items.length === 0) items.push({ id: "none", text: "Новых уведомлений нет.", urgent: false });
    return items;
  }, [myAppts]);

  return (
    <>
      <header className="border-border flex-none border-b px-7 py-[18px] max-md:px-5">
        <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">Мой кабинет</h1>
        <p className="text-text-muted mt-1 text-xs">
          {myName || "Врач"} · {roomName}
        </p>
      </header>

      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile label="Приёмов сегодня" value={myAppts.length} hint={`пришли ${arrived}`} />
          <Tile label="Часы" value={hours.toFixed(1)} />
          <Tile label="Неявки" value={noShow} />
          <Tile label="Выручка" value={formatMoney(revenue)} />
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <section className="border-border bg-surface rounded-xl border p-5">
            <h2 className="mb-3 text-sm font-medium">Моё расписание · {roomName}</h2>
            {myAppts.length === 0 ? (
              <p className="text-text-subtle text-sm">Записей на сегодня нет.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {myAppts.map((a) => (
                  <li key={a.id} className="border-border-soft flex items-baseline gap-3 rounded-lg border px-3 py-2.5">
                    <span className={`num text-sm font-medium ${a.status === "no_show" ? "line-through" : ""}`}>
                      {formatMinute(a.startMinute)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        {a.patientId ? (
                          <Link href={`/patients/${a.patientId}`} className="hover:underline">
                            {a.patientName}
                          </Link>
                        ) : (
                          a.patientName
                        )}
                      </span>
                      <span className="text-text-subtle block truncate text-xs">{a.service}</span>
                      {a.note ? (
                        <span className="text-text-muted block text-2xs italic">«{a.note}»</span>
                      ) : null}
                      <VisitNote appt={a} />
                    </span>
                    <span className="text-text-subtle flex-none text-2xs">{APPT_STATUS[a.status]}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="border-border bg-surface rounded-xl border p-5">
            <h2 className="mb-3 text-sm font-medium">Уведомления</h2>
            <ul className="flex flex-col gap-2">
              {notifications.map((n) => (
                <li key={n.id} className="flex gap-2 text-sm leading-snug">
                  <span aria-hidden className={`flex-none ${n.urgent ? "text-accent-text" : "text-text-subtle"}`}>•</span>
                  <span className={n.urgent ? "text-text" : "text-text-muted"}>{n.text}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="mt-4">
          <InternalStaffChat compact />
        </div>
      </div>
    </>
  );
}

function Tile({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="border-border bg-surface rounded-xl border px-4 py-3.5">
      <div className="text-text-subtle text-2xs">{label}</div>
      <div className="readout mt-1 text-xl">{value}</div>
      {hint ? <div className="text-text-subtle mt-0.5 text-2xs">{hint}</div> : null}
    </div>
  );
}
