"use client";

import { useState, useTransition } from "react";
import { setDeviceExcluded, setDeviceNote, systemReport } from "./actions";
import type { SystemReport } from "@/lib/server/system-report";

/**
 * Экран учёта. Смотрят его редко и с одной целью — понять, как платформой
 * пользуются на самом деле, и по этому решать, что чинить дальше.
 *
 * Поэтому здесь плотные таблицы и никакой декорации: это не витрина, а
 * рабочий разбор. Каждое число сопровождается тем, из чего оно посчитано, —
 * без этого цифры на таком экране начинают жить собственной жизнью.
 */

const WINDOWS = [
  { days: 1, label: "сутки" },
  { days: 7, label: "неделя" },
  { days: 30, label: "месяц" },
  { days: 90, label: "3 месяца" },
];

const WHEN = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});

const ROLE: Record<string, string> = {
  OWNER: "владелец",
  ADMIN: "администратор",
  MANAGER: "управляющий",
  DOCTOR: "врач",
};

function when(iso: string | null): string {
  return iso ? WHEN.format(new Date(iso)) : "—";
}

export function SistemClient({ initial }: { initial: SystemReport }) {
  const [data, setData] = useState(initial);
  const [days, setDays] = useState(initial.windowDays);
  const [editing, setEditing] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const reload = (next: number) => {
    setDays(next);
    setError(null);
    start(async () => {
      try {
        setData(await systemReport(next));
      } catch (e) {
        setError((e as Error)?.message || "Не удалось обновить");
      }
    });
  };

  const toggle = (userId: string, fingerprint: string, excluded: boolean) => {
    setError(null);
    start(async () => {
      try {
        setData(await setDeviceExcluded(userId, fingerprint, excluded, days));
      } catch (e) {
        setError((e as Error)?.message || "Не удалось сохранить");
      }
    });
  };

  const saveNote = (userId: string, fingerprint: string) => {
    const text = noteText;
    setEditing(null);
    start(async () => {
      try {
        setData(await setDeviceNote(userId, fingerprint, text, days));
      } catch (e) {
        setError((e as Error)?.message || "Не удалось сохранить");
      }
    });
  };

  const peak = Math.max(1, ...data.days.map((d) => d.actions));
  /** Перезапусков больше одного в сутки — это не норма, а повод разбираться. */
  const restartsWorrying = data.restarts.last24h > 1;
  const nearLimit =
    data.memory.limitMb !== null && data.memory.rssMb > data.memory.limitMb * 0.8;

  return (
    <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
      <header className="mb-5">
        <h1 className="text-lg font-medium">Учёт</h1>
        <p className="text-text-muted mt-1 max-w-[70ch] text-sm leading-relaxed">
          Кто заходит в платформу, с каких устройств и что делает. Считается из журнала
          действий, который ведётся и так, — отдельной записи ради этого экрана не
          появилось, поэтому на скорость работы он не влияет.
        </p>
      </header>

      <div className="mb-5 flex flex-wrap items-center gap-1.5">
        {WINDOWS.map((w) => (
          <button
            key={w.days}
            type="button"
            disabled={pending}
            onClick={() => reload(w.days)}
            className={
              days === w.days
                ? "bg-accent text-accent-contrast rounded-md px-2.5 py-1 text-xs font-medium"
                : "border-border text-text-muted hover:bg-hover rounded-md border px-2.5 py-1 text-xs disabled:opacity-50"
            }
          >
            {w.label}
          </button>
        ))}
        <span className="text-text-subtle ml-2 text-2xs">
          разобрано записей журнала: {data.rows}
          {data.truncated ? " — упёрлись в предел, показана часть срока" : ""}
        </span>
      </div>

      {error ? <p className="text-danger-text mb-4 text-sm">{error}</p> : null}

      {/* ── Состояние процесса: отсюда видно «слетает» ── */}
      <section className="border-border bg-surface mb-5 rounded-xl border p-4">
        <h2 className="text-sm font-medium">Как чувствует себя сервер</h2>
        <p className="text-text-subtle mt-1 max-w-[70ch] text-2xs leading-relaxed">
          pm2 перезапускает приложение, когда память переходит предел, и делает это молча.
          Со стороны это выглядит как «платформа слетела»: несколько секунд она не
          отвечает, а в браузере может мелькнуть офлайн-заглушка.
        </p>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <span>
            память сейчас{" "}
            <b className={`num ${nearLimit ? "text-accent-text" : "text-text"} font-medium`}>
              {data.memory.rssMb} МБ
            </b>
            {data.memory.limitMb !== null ? (
              <span className="text-text-subtle"> из {data.memory.limitMb} МБ</span>
            ) : (
              <span className="text-text-subtle"> · предел не задан в окружении</span>
            )}
          </span>
          <span className="text-text-muted">
            куча <b className="num">{data.memory.heapUsedMb}</b> из {data.memory.heapTotalMb} МБ
          </span>
          <span className="text-text-muted">
            работает без перезапуска <b className="num">{data.memory.uptimeMin}</b> мин
          </span>
          <span className={restartsWorrying ? "text-accent-text" : "text-text-muted"}>
            перезапусков за сутки <b className="num">{data.restarts.last24h}</b>, за неделю{" "}
            <b className="num">{data.restarts.last7d}</b>
          </span>
        </div>
        {data.restarts.recent.length > 0 ? (
          <div className="text-text-subtle mt-3 text-2xs">
            последние запуски:{" "}
            {data.restarts.recent
              .map((r) => `${when(r.at)}${r.rssMb !== null ? ` (${r.rssMb} МБ)` : ""}`)
              .join(" · ")}
          </div>
        ) : (
          <p className="text-text-subtle mt-3 text-2xs">
            Запусков ещё не записано. Отметка появляется при старте процесса — она будет
            после ближайшей выкатки.
          </p>
        )}
        {restartsWorrying ? (
          <p className="text-accent-text mt-2 text-2xs leading-relaxed">
            Перезапусков за сутки больше одного. Если рядом стоит память, близкая к пределу,
            — приложение убивают по памяти, и предел стоит поднять (PM2_MAX_MEMORY_MB).
          </p>
        ) : null}
      </section>

      {/* ── Люди ── */}
      <section className="border-border bg-surface mb-5 rounded-xl border">
        <div className="border-border border-b px-4 py-3">
          <h2 className="text-sm font-medium">Кто и что делал</h2>
          <p className="text-text-subtle mt-0.5 text-2xs">
            за {data.windowDays} дн. · учётки без единого входа показаны с нулём — это
            ответ на свой вопрос, а не пустая строка
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-text-subtle text-2xs">
              <tr className="border-border-soft border-b">
                <th className="px-4 py-2 text-left font-normal">сотрудник</th>
                <th className="px-4 py-2 text-left font-normal">роль</th>
                <th className="px-4 py-2 text-right font-normal">действий</th>
                <th className="px-4 py-2 text-right font-normal">входов</th>
                <th className="px-4 py-2 text-right font-normal">устройств</th>
                <th className="px-4 py-2 text-left font-normal">последний раз</th>
                <th className="px-4 py-2 text-left font-normal">чем занимался</th>
              </tr>
            </thead>
            <tbody>
              {data.people.map((p) => (
                <tr key={p.userId ?? "none"} className="border-border-soft border-b last:border-0">
                  <td className="px-4 py-2">{p.name}</td>
                  <td className="text-text-muted px-4 py-2 text-xs">{ROLE[p.role] ?? p.role}</td>
                  <td className="num px-4 py-2 text-right">{p.actions}</td>
                  <td className="num text-text-muted px-4 py-2 text-right">{p.logins}</td>
                  <td className="num text-text-muted px-4 py-2 text-right">{p.devices}</td>
                  <td className="text-text-muted px-4 py-2 text-xs">{when(p.lastSeenAt)}</td>
                  <td className="text-text-muted px-4 py-2 text-2xs">
                    {p.byAction.length === 0
                      ? "—"
                      : p.byAction
                          .slice(0, 4)
                          .map((a) => `${a.label} ${a.count}`)
                          .join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Устройства ── */}
      <section className="border-border bg-surface mb-5 rounded-xl border">
        <div className="border-border border-b px-4 py-3">
          <h2 className="text-sm font-medium">Устройства</h2>
          <p className="text-text-subtle mt-0.5 max-w-[80ch] text-2xs leading-relaxed">
            Все устройства всех ролей. Модель аппарата браузер не сообщает — у всех Mac
            строка одна и та же, у всех iPhone тоже, — поэтому «MacBook Air M2» от другого
            Mac здесь не отличить. Чтобы не учитывать свои устройства, отметьте их кнопкой
            «моё»: отметка точная, по конкретному аппарату и браузеру.
          </p>
          {data.excludedDevices > 0 ? (
            <p className="text-accent-text mt-1.5 text-2xs">
              Скрыто устройств: {data.excludedDevices}, их действий за срок:{" "}
              {data.excludedActions}. Молча не пропадает ничего.
            </p>
          ) : null}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-text-subtle text-2xs">
              <tr className="border-border-soft border-b">
                <th className="px-4 py-2 text-left font-normal">устройство</th>
                <th className="px-4 py-2 text-left font-normal">чьё</th>
                <th className="px-4 py-2 text-right font-normal">входов</th>
                <th className="px-4 py-2 text-right font-normal">действий</th>
                <th className="px-4 py-2 text-left font-normal">последний раз</th>
                <th className="px-4 py-2 text-left font-normal">адрес</th>
                <th className="px-4 py-2 text-left font-normal"> </th>
              </tr>
            </thead>
            <tbody>
              {data.devices.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-text-subtle px-4 py-6 text-sm">
                    Устройств пока не записано. Отметка заводится при входе — появится после
                    ближайшего входа в систему.
                  </td>
                </tr>
              ) : (
                data.devices.map((d) => (
                  <tr
                    key={`${d.userId}-${d.fingerprint}`}
                    className={`border-border-soft border-b last:border-0 ${d.excluded ? "opacity-50" : ""}`}
                  >
                    <td className="px-4 py-2">
                      <span className="block">{d.label}</span>
                      <span className="text-text-subtle block text-2xs">
                        {d.kindLabel}
                        {d.note ? ` · ${d.note}` : ""}
                        {d.id === null ? " · пока только по журналу" : ""}
                      </span>
                    </td>
                    <td className="text-text-muted px-4 py-2 text-xs">
                      {d.userName}
                      <span className="text-text-subtle"> · {ROLE[d.userRole] ?? d.userRole}</span>
                    </td>
                    <td className="num px-4 py-2 text-right">{d.logins}</td>
                    <td className="num px-4 py-2 text-right">{d.actions}</td>
                    <td className="text-text-muted px-4 py-2 text-xs">{when(d.lastSeenAt)}</td>
                    <td className="num text-text-subtle px-4 py-2 text-2xs">
                      {d.ips.length > 0 ? d.ips.join(", ") : "—"}
                    </td>
                    <td className="px-4 py-2">
                      {/*
                        Кнопки доступны и у устройств, известных только по
                        журналу: отметка о входе появилась позже самого
                        журнала, и у давно работающих аппаратов своей строки
                        ещё нет. Именно свои устройства владелец отмечает
                        первыми — строка заводится в момент отметки.
                      */}
                      {d.userId === null ? (
                        <span
                          className="text-text-subtle text-2xs"
                          title="Действие без учётки: фоновая задача или вебхук. Отмечать нечего."
                        >
                          —
                        </span>
                      ) : editing === `${d.userId}|${d.fingerprint}` ? (
                        <span className="flex items-center gap-1.5">
                          <input
                            autoFocus
                            value={noteText}
                            onChange={(e) => setNoteText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveNote(d.userId!, d.fingerprint);
                              if (e.key === "Escape") setEditing(null);
                            }}
                            placeholder="мой ноутбук"
                            className="border-border-input bg-surface w-28 rounded-md border px-2 py-1 text-2xs outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => saveNote(d.userId!, d.fingerprint)}
                            className="text-accent-text text-2xs"
                          >
                            ок
                          </button>
                        </span>
                      ) : (
                        <span className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => toggle(d.userId!, d.fingerprint, !d.excluded)}
                            className="border-border text-text-muted hover:bg-hover rounded-md border px-2 py-1 text-2xs disabled:opacity-50"
                          >
                            {d.excluded ? "учитывать" : "моё"}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditing(`${d.userId}|${d.fingerprint}`);
                              setNoteText(d.note ?? "");
                            }}
                            className="text-text-subtle hover:text-text text-2xs"
                          >
                            подписать
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Последние действия по одному ── */}
      <section className="border-border bg-surface mb-5 rounded-xl border">
        <div className="border-border border-b px-4 py-3">
          <h2 className="text-sm font-medium">Последние действия</h2>
          <p className="text-text-subtle mt-0.5 max-w-[80ch] text-2xs leading-relaxed">
            Сводка выше отвечает «сколько», а разбирают всегда конкретный случай — кто
            открывал эту переписку и когда. Показаны последние {data.recent.length} за
            выбранный срок. Адрес экрана записывается образцом: параметры запроса не
            сохраняются, в них живут идентификаторы пациентов.
          </p>
        </div>
        {data.recent.length === 0 ? (
          <p className="text-text-subtle px-4 py-6 text-sm">
            За этот срок действий не записано. Открытия экранов и переписок начали
            записываться с этой версии — про прошлое журнал честно молчит.
          </p>
        ) : (
          <ul className="max-h-[420px] overflow-auto">
            {data.recent.map((e, i) => (
              <li
                key={`${e.at}-${i}`}
                className="border-border-soft flex items-baseline gap-3 border-b px-4 py-1.5 text-xs last:border-0"
              >
                <span className="num text-text-subtle w-24 flex-none">{when(e.at)}</span>
                <span className="w-44 flex-none truncate">{e.userName}</span>
                <span className="min-w-0 flex-1 truncate">{e.what}</span>
                <span className="text-text-subtle flex-none">{e.deviceLabel}</span>
                <span className="num text-text-subtle w-28 flex-none truncate text-right">
                  {e.ip ?? "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── По дням ── */}
      <section className="border-border bg-surface rounded-xl border p-4">
        <h2 className="text-sm font-medium">Действий по дням</h2>
        <p className="text-text-subtle mt-0.5 text-2xs">
          Провал в рабочий день означает, что в платформе не работали, — и это повод
          спросить почему, а не считать день тихим.
        </p>
        {data.days.length === 0 ? (
          <p className="text-text-subtle mt-3 text-sm">За этот срок действий не записано.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-1">
            {data.days.map((d) => (
              <li key={d.day} className="flex items-center gap-3 text-xs">
                <span className="num text-text-subtle w-12 flex-none">{d.day}</span>
                <span className="bg-hover h-2 flex-1 overflow-hidden rounded-full">
                  <span
                    className="bg-accent block h-full rounded-full"
                    style={{ width: `${Math.round((d.actions / peak) * 100)}%` }}
                  />
                </span>
                <span className="num text-text-muted w-20 flex-none text-right">
                  {d.actions}
                  {d.logins > 0 ? <span className="text-text-subtle"> · {d.logins} вх.</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
