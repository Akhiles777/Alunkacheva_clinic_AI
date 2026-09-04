import { formatMoney, formatNumber, formatPercent } from "@/lib/format";
import type { CourseEconomics } from "@/lib/server/course-economics";

/**
 * Экономика курсов — один блок на отчёты и на кабинет владельца.
 *
 * Общий компонент, а не два похожих: курс — главный товар клиники, и две
 * версии этих чисел на двух экранах означали бы, что владелец поверит
 * удобной. Считает всё `lib/server/course-economics.ts`, здесь только подписи.
 *
 * Главное правило показа: **обязательства не выручка**. Число «отработать на
 * 412 000 ₽» стоит рядом с деньгами месяца, и без явной подписи его
 * складывают с ними — получается выручка, которой не было. Деньги за курс
 * клиника получила в день продажи и уже посчитала (§8).
 */

function Figure({
  label,
  value,
  hint,
  title,
}: {
  label: string;
  value: string;
  hint?: string;
  title?: string;
}) {
  return (
    <div className="border-border bg-surface rounded-xl border px-4 py-3.5" title={title}>
      <div className="text-text-subtle text-2xs">{label}</div>
      <div className="readout mt-1 text-xl">{value}</div>
      {hint ? <div className="text-text-subtle mt-0.5 text-2xs">{hint}</div> : null}
    </div>
  );
}

/** «раз в 9 дней» — так, как это произносят вслух. */
function rhythmLabel(days: number | null): string {
  if (days === null) return "—";
  const rounded = Math.round(days * 10) / 10;
  return `раз в ${String(rounded).replace(".", ",")} дн.`;
}

export function CourseEconomicsBlock({ data }: { data: CourseEconomics }) {
  const { completion: c, outstanding: o, repurchase: r } = data;

  if (!data.hasCourses) {
    return (
      <p className="text-text-muted text-sm">
        Курсов в базе нет: ни одной покупки не разобрано в курс. Курс собирается, когда пациент
        начал ходить, — до первого сеанса его ещё нет.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* ── доходимость */}
      <div>
        <h3 className="text-text-muted mb-2 text-2xs">
          Доходимость курсов, купленных за период ({data.periodLabel})
        </h3>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Figure
            label="Дошли до конца"
            value={c.rate === null ? "—" : formatPercent(c.rate)}
            hint={
              c.rate === null
                ? "решившихся курсов ещё нет"
                : `${formatNumber(c.completed)} из ${formatNumber(c.completed + c.abandoned)} решившихся`
            }
            title="Доля считается только по решившимся курсам: пройденным и брошенным. Идущий курс не «недошедший» — судить о нём рано."
          />
          <Figure
            label="Брошено"
            value={formatNumber(c.abandoned)}
            hint="сеансы остались, записи нет, порог пройден"
          />
          <Figure
            label="Ещё идут"
            value={formatNumber(c.inProgress)}
            hint="в долю не входят — судить рано"
          />
          <Figure
            label="Сеансов пройдено"
            value={
              c.sessionsPaid === 0
                ? "—"
                : `${formatNumber(c.sessionsUsed)} из ${formatNumber(c.sessionsPaid)}`
            }
            hint={c.sessionsPaid === 0 ? "курсов за период не покупали" : "из оплаченных"}
          />
        </div>
        {c.undecidable > 0 ? (
          <p className="text-text-subtle mt-2 text-2xs">
            Ещё {formatNumber(c.undecidable)} курсов не отнесены никуда: у их услуги не задан порог
            «пора звать», а запасного порога клиники нет. Брошен курс или идёт — сказать не на чем.
          </p>
        ) : null}
      </div>

      {/* ── обязательства */}
      <div>
        <h3 className="text-text-muted mb-2 text-2xs">
          Оплачено вперёд и не отработано — на сегодня
        </h3>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Figure
            label="Обязательства"
            value={formatMoney(o.obligation)}
            hint={`${formatNumber(o.sessions)} сеансов в ${formatNumber(o.courses)} курсах`}
            title="Это не выручка. Деньги за курс клиника получила в день продажи и уже посчитала; здесь — работа, которую предстоит сделать."
          />
          <Figure
            label="Из них под угрозой"
            value={formatMoney(o.atRisk)}
            hint={`${formatNumber(o.atRiskCourses)} курсов выпали из графика`}
            title="Те же деньги, но вернуть их труднее: человека сначала надо позвать. Список — в разделе «Кому позвонить»."
          />
          <Figure
            label="Сеансов назначено"
            value={formatNumber(o.scheduledSessions)}
            hint="стоят в расписании — обязательство с датой"
          />
          <Figure
            label="Не назначено"
            value={formatNumber(Math.max(o.sessions - o.scheduledSessions, 0))}
            hint="сеансы без даты: их ещё предстоит записать"
          />
        </div>
        {/*
          Подпись обязательна. Без неё число складывают с выручкой месяца —
          и получают деньги, которых не было.
        */}
        <p className="text-text-subtle mt-2 text-2xs">
          Это обязательства и потенциал, а не выручка: деньги за курсы клиника получила в дни
          продаж и посчитала тогда же. Складывать эту сумму с выручкой периода нельзя.
        </p>
      </div>

      {/* ── повторные покупки */}
      <div>
        <h3 className="text-text-muted mb-2 text-2xs">
          Возвращаются ли за вторым курсом (окно {r.windowDays} дней)
        </h3>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Figure
            label="Купили ещё курс"
            value={r.rate === null ? "—" : formatPercent(r.rate)}
            hint={
              r.rate === null
                ? "закончивших давно ещё нет"
                : `${formatNumber(r.repurchased)} из ${formatNumber(r.cohort)} закончивших`
            }
            title="Считается по курсам, законченным достаточно давно: у прошедшего последний сеанс на прошлой неделе ещё не было времени вернуться."
          />
          <Figure
            label="Ждём"
            value={formatNumber(r.tooEarly)}
            hint="закончили недавно — окно не прошло"
          />
          <Figure
            label="Возвращаются через"
            value={r.medianDaysToRepurchase === null ? "—" : `${formatNumber(r.medianDaysToRepurchase)} дн.`}
            hint="медиана по вернувшимся"
          />
          <Figure
            label="Закончили за период"
            value={formatNumber(r.cohort + r.tooEarly)}
            hint="курсов дошло до последнего сеанса"
          />
        </div>
      </div>

      {/* ── ритм */}
      {data.rhythm.length > 0 ? (
        <div>
          <h3 className="text-text-muted mb-2 text-2xs">Как часто ходят на сеансы</h3>
          <div className="-mx-1 overflow-x-auto px-1">
            <table className="w-full min-w-[440px] border-collapse text-sm">
              <thead>
                <tr className="text-text-subtle text-left text-2xs">
                  <th className="py-2 pr-3 font-normal">Услуга</th>
                  <th className="py-2 pr-3 text-right font-normal">Ритм (медиана)</th>
                  <th className="py-2 pr-3 text-right font-normal">Среднее</th>
                  <th className="py-2 pr-3 text-right font-normal">Курсов</th>
                  <th className="py-2 text-right font-normal">Промежутков</th>
                </tr>
              </thead>
              <tbody>
                {data.rhythm.map((row) => (
                  <tr key={row.serviceTitle} className="border-border-soft border-t">
                    <td className="py-2 pr-3">{row.serviceTitle}</td>
                    <td className="num py-2 pr-3 text-right">{rhythmLabel(row.medianDays)}</td>
                    <td className="num text-text-subtle py-2 pr-3 text-right">
                      {rhythmLabel(row.meanDays)}
                    </td>
                    <td className="num py-2 pr-3 text-right">{formatNumber(row.courses)}</td>
                    <td className="num py-2 text-right">{formatNumber(row.gaps)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-text-subtle mt-2 text-2xs">
            Медиана, а не среднее: один отпуск в три недели сдвигает среднее так, что типичный ритм
            исчезает. Среднее стоит рядом вторым числом.
          </p>
        </div>
      ) : null}
    </div>
  );
}
