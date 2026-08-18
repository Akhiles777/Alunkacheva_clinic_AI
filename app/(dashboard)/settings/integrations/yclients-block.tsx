"use client";

import { useEffect, useState, useTransition } from "react";
import { Group } from "../_components/ui";
import {
  getYclientsState,
  retryPending,
  runYclientsReconcile,
  startYclientsSync,
  type RunResult,
  type YclientsState,
} from "./yclients-actions";
import type { ReconcileReport } from "@/lib/integrations/yclients/reconcile";

/**
 * Синхронизация с YCLIENTS: запуск выгрузки, состояние по сущностям и сверка.
 *
 * Сверка — не украшение. Утверждать «выгрузка полная» можно только показав
 * сравнение: пропущенная страница или неудачный диапазон дат выглядят точно
 * так же, как успешный прогон.
 */
export function YclientsBlock() {
  const [state, setState] = useState<YclientsState | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [report, setReport] = useState<ReconcileReport | null>(null);
  const [pending, start] = useTransition();

  const load = () => getYclientsState().then(setState).catch(() => {});
  useEffect(() => {
    load();
  }, []);

  /**
   * Пока выгрузка идёт — опрашиваем состояние.
   *
   * Полная выгрузка занимает минуты: без опроса экран замирал бы на «идёт»
   * до перезагрузки страницы, и понять, живо оно или упало, было бы нельзя.
   */
  useEffect(() => {
    if (!state?.running) return;
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [state?.running]);

  if (!state) {
    return (
      <Group title="Синхронизация с YCLIENTS" hint="выгрузка данных и сверка">
        <p className="text-text-subtle text-sm">Загружаем состояние…</p>
      </Group>
    );
  }

  const blocked = !state.enabled || !state.configured || state.running;

  return (
    <Group
      title="Синхронизация с YCLIENTS"
      hint="YCLIENTS — источник истины по расписанию, записям и выручке"
    >
      {!state.enabled ? (
        <p className="text-text-muted text-sm">
          Интеграция выключена. Чтобы включить, задайте на хостинге{" "}
          <span className="num">YCLIENTS_ENABLED=true</span> — до этого ни одного обращения к их API
          не происходит.
        </p>
      ) : null}
      {state.enabled && !state.configured ? (
        <p className="text-accent-text text-sm">
          Не заданы ключи: нужны партнёрский токен, пользовательский токен и ID филиала — выше в
          этом разделе.
        </p>
      ) : null}

      <div className="border-border overflow-hidden rounded-lg border">
        {/* Таблица шире телефона: прокручиваем её саму, а не всю страницу. */}
        <div className="-mx-1 overflow-x-auto px-1">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-border bg-surface border-b text-left">
                <th className="text-text-subtle px-3 py-2 text-2xs font-normal">Данные</th>
                <th className="text-text-subtle px-3 py-2 text-2xs font-normal">Состояние</th>
                <th className="text-text-subtle px-3 py-2 text-2xs font-normal">Последняя выгрузка</th>
              </tr>
            </thead>
            <tbody>
              {state.cursors.map((c) => (
                <tr key={c.entity} className="border-border-soft border-b last:border-b-0">
                  <td className="px-3 py-2">{c.label}</td>
                  <td className="px-3 py-2">
                    {c.status}
                    {c.error ? <span className="text-accent-text block text-xs">{c.error}</span> : null}
                  </td>
                  <td className="text-text-muted px-3 py-2 whitespace-nowrap">
                    {c.lastSyncedAt ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/*
        Что выгрузка принесла. Таблица выше отвечает «когда», а спрашивают
        обычно «что»: успешный круг без единого изменения выглядит там ровно
        так же, как круг с сорока новыми отметками «пришёл».
      */}
      <div className="border-border bg-bg rounded-lg border p-3.5">
        <div className="text-text-subtle text-2xs">Что приехало за сутки</div>
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1.5 text-sm">
          <span>
            новых визитов <b className="num text-text">{state.changes.newVisits}</b>
          </span>
          <span>
            изменилось <b className="num text-text">{state.changes.changedVisits}</b>
          </span>
          <span>
            отмечено «пришёл» <b className="num text-text">{state.changes.arrivedMarked}</b>
          </span>
          <span>
            новых пациентов <b className="num text-text">{state.changes.newPatients}</b>
          </span>
        </div>
        {state.changes.newVisits === 0 &&
        state.changes.changedVisits === 0 &&
        state.changes.newPatients === 0 ? (
          <p className="text-text-subtle mt-2 text-xs">
            За сутки в YCLIENTS ничего не менялось — выгрузка работает, приносить нечего.
          </p>
        ) : null}
      </div>

      {/*
        Качество данных. Бесплатная услуга, посчитанная за 3000 ₽, и дубли —
        то, что раньше обнаруживалось только в разговоре с клиентом.
      */}
      <div className="border-border bg-bg rounded-lg border p-3.5">
        <div className="text-text-subtle text-2xs">Качество данных по визитам</div>
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1.5 text-sm">
          <span>
            цена подставлена из прайса{" "}
            <b className="num text-text">{state.quality.priceFromList}</b>
          </span>
          <span>
            отдано бесплатно <b className="num text-text">{state.quality.free}</b>
          </span>
          <span>
            задвоенных приёмов{" "}
            <b className={`num ${state.quality.duplicateGroups > 0 ? "text-accent-text" : "text-text"}`}>
              {state.quality.duplicateGroups}
            </b>
          </span>
        </div>
        {state.quality.arrivedInFuture > 0 ? (
          <p className="text-text-muted mt-2 text-xs">
            Визитов в будущем с отметкой «пришёл»:{" "}
            <b className="num text-accent-text">{state.quality.arrivedInFuture}</b>. Приём, время
            которого ещё не наступило, состояться не мог — обычно так остаётся отметка с прежней
            даты после переноса записи. В выручку и в число пришедших мы их не берём; поправить
            стоит в YCLIENTS.
          </p>
        ) : null}
        {state.quality.duplicateGroups > 0 ? (
          <p className="text-text-muted mt-2 text-xs">
            Задвоенный приём — один пациент, один специалист и одно время в двух визитах. Если оба
            визита есть в YCLIENTS, чинить нужно там: выгрузка вернёт их обратно, потому что
            расписание ведёт YCLIENTS.
          </p>
        ) : null}
        {state.quality.priceFromList > 0 ? (
          <p className="text-text-subtle mt-2 text-xs">
            «Из прайса» — в записи YCLIENTS стоимости не было, и мы взяли цену услуги. Это не
            ошибка, но и не факт из кассы: чем таких визитов меньше, тем точнее выручка.
          </p>
        ) : null}
      </div>

      {/*
        Расписание выгрузки. Отметки в таблице выше говорят, когда данные
        приезжали в последний раз, но не говорят, приедут ли они снова:
        остановившееся расписание выглядит там ровно так же, как работающее.
      */}
      <p className="text-text-muted text-sm">
        {state.schedule.on ? (
          <>
            Выгрузка идёт сама каждые{" "}
            <b className="num text-text">{state.schedule.intervalMin} мин</b>
            {state.schedule.runningNow ? " · круг идёт прямо сейчас" : null}
            {state.schedule.lastAt ? (
              <>
                {" · последний круг "}
                <span className="num">{state.schedule.lastAt}</span>
                {state.schedule.lastOk === false ? (
                  <span className="text-accent-text">
                    {" "}
                    — не удался{state.schedule.lastError ? `: ${state.schedule.lastError}` : ""}
                  </span>
                ) : state.schedule.lastMs !== null ? (
                  <span className="text-text-subtle"> — за {Math.round(state.schedule.lastMs / 1000)} с</span>
                ) : null}
              </>
            ) : state.schedule.firstRunInFlight ? (
              " · первый круг идёт сейчас"
            ) : (
              " · первый круг ещё не проходил"
            )}
          </>
        ) : (
          <span className="text-accent-text">
            Автоматическая выгрузка выключена — данные обновляются только кнопкой ниже.
          </span>
        )}
      </p>

      {state.notPushed > 0 || state.conflicts > 0 ? (
        <p className="text-text-muted text-sm">
          Визитов, не отправленных в YCLIENTS: <b className="num text-text">{state.notPushed}</b>
          {state.conflicts > 0 ? (
            <>
              {" · "}
              <span className="text-accent-text">
                слот занят у {state.conflicts} — их нужно перенести вручную
              </span>
            </>
          ) : null}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          disabled={pending || blocked}
          onClick={() =>
            start(async () => {
              setReport(null);
              setResult(await startYclientsSync());
              await load();
            })
          }
          className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-4 py-2 text-sm font-medium disabled:opacity-45"
        >
          {state.running ? "Выгрузка идёт…" : pending ? "Запускаем…" : "Выгрузить данные"}
        </button>
        {/*
          Полная выгрузка отдельной кнопкой. Обычная берёт визиты от последней
          успешной синхронизации; если первая прошла с изъяном, отметка всё
          равно встаёт на «сейчас», и дальше приезжает только последняя
          неделя. Снаружи это выглядит как «выгрузка прошла, а визитов нет».
        */}
        <button
          type="button"
          disabled={pending || blocked}
          onClick={() =>
            start(async () => {
              setReport(null);
              setResult(await startYclientsSync(true));
              await load();
            })
          }
          className="border-border text-text hover:bg-hover rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-45"
          title="Забрать историю заново, не полагаясь на отметки о прошлых выгрузках"
        >
          Полная выгрузка заново
        </button>
        <button
          type="button"
          disabled={pending || blocked}
          onClick={() =>
            start(async () => {
              setResult(null);
              setReport(await runYclientsReconcile());
            })
          }
          className="border-border text-text-muted hover:bg-hover rounded-md border px-3 py-2 text-sm disabled:opacity-45"
        >
          Сверить с YCLIENTS
        </button>
        {state.notPushed > 0 ? (
          <button
            type="button"
            disabled={pending || blocked}
            onClick={() =>
              start(async () => {
                setResult(await retryPending());
                await load();
              })
            }
            className="border-border text-text-muted hover:bg-hover rounded-md border px-3 py-2 text-sm disabled:opacity-45"
          >
            Отправить незагруженные визиты
          </button>
        ) : null}
      </div>

      {result ? (
        <p className={`text-sm ${result.ok ? "text-text-muted" : "text-accent-text"}`}>
          {result.message}
          {result.counts
            ? ` ${Object.entries(result.counts)
                .map(([k, v]) => `${k}: ${v}`)
                .join(", ")}`
            : ""}
        </p>
      ) : null}

      {report ? <ReportView report={report} /> : null}
    </Group>
  );
}

function ReportView({ report }: { report: ReconcileReport }) {
  if (report.skipped) {
    return <p className="text-text-subtle text-sm">Сверять нечего: интеграция выключена или нет ключей.</p>;
  }

  return (
    <div className="border-border-soft mt-1 rounded-lg border p-3">
      <p className={`text-sm font-medium ${report.ok ? "" : "text-accent-text"}`}>
        {report.ok ? "Расхождений нет" : "Есть расхождения"}
      </p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {report.entities.map((e) => (
          <li key={e.entity} className="text-sm">
            <span className="inline-block w-32">{e.entity}</span>
            <span className="num text-text-muted">
              в YCLIENTS {e.remote} · у нас {e.local}
            </span>
            {e.note ? <span className="text-accent-text ml-2 text-xs">{e.note}</span> : null}
            {!e.ok && !e.note ? (
              <span className="text-accent-text ml-2 text-xs">
                {e.missingLocally.length > 0 ? `не доехало: ${e.missingLocally.join(", ")}` : ""}
                {e.staleLocally.length > 0 ? ` лишнее у нас: ${e.staleLocally.join(", ")}` : ""}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {report.notPushed > 0 ? (
        <p className="text-text-muted mt-2 text-xs">
          Не отправлено в YCLIENTS визитов: {report.notPushed}
          {report.conflicts > 0 ? `, из них со слотом, который занят: ${report.conflicts}` : ""}
        </p>
      ) : null}
    </div>
  );
}
