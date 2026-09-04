import { formatNumber, formatPercent } from "@/lib/format";
import { Donut } from "../_components/donut";
import type { AgentStats } from "@/lib/server/agent-stats";

/**
 * «Работа ассистента» в кабинете владельца.
 *
 * Экран ничего не считает: все числа приходят готовыми из
 * `lib/server/agent-stats.ts`, а тот — из функций `lib/metrics/`. Здесь только
 * подписи и раскладка.
 *
 * Два правила показа, из которых вырос весь раздел:
 *
 *   — отсутствие данных показывается как отсутствие, а не как ноль. «Медиана
 *     0 мс» и «доля 0%» — утверждения, которых мы не делали;
 *   — экономия времени никогда не стоит одна: рядом всегда встречное число,
 *     сколько разговоров агент отдал людям и сколько это заняло.
 */

/** Длительность из миллисекунд — словами, а не «123456 мс». */
function duration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms} мс`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} с`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} мин`;
  const hours = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
}

/** Долгое время в часах — для экономии, где счёт идёт на часы. */
function hours(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60000)} мин`;
  return `${h.toFixed(1).replace(".", ",")} ч`;
}

const logDay = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  timeZone: "Europe/Moscow",
});

const REASON_LABEL: Record<string, string> = {
  AGENT_REQUEST: "агент сам позвал",
  PATIENT_REQUEST: "пациент просил человека",
  KEYWORD: "стоп-слово",
  MEDICAL_QUESTION: "медицинский вопрос",
  MISUNDERSTOOD: "не понял запрос",
  TIMEOUT: "долго молчал",
  OTHER: "другое",
};

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

/** Медиана крупно, среднее рядом мельче — как договорились. */
function Speed({
  label,
  stats,
  title,
}: {
  label: string;
  stats: { medianMs: number | null; meanMs: number | null; count: number };
  title?: string;
}) {
  return (
    <div className="border-border bg-surface rounded-xl border px-4 py-3.5" title={title}>
      <div className="text-text-subtle text-2xs">{label}</div>
      {stats.count === 0 ? (
        <div className="text-text-subtle mt-1 text-sm">за период не было</div>
      ) : (
        <>
          <div className="readout mt-1 text-xl">{duration(stats.medianMs)}</div>
          <div className="text-text-subtle mt-0.5 text-2xs">
            среднее {duration(stats.meanMs)} · ответов {formatNumber(stats.count)}
          </div>
        </>
      )}
    </div>
  );
}

export function AgentSection({ stats, periodLabel }: { stats: AgentStats; periodLabel: string }) {
  const { reliability: rel, autonomy, savings, responseTime: rt, assist, waiting } = stats;

  return (
    <section className="border-border bg-surface mt-4 rounded-xl border p-5">
      <h2 className="text-sm font-medium">Работа ассистента</h2>
      <p className="text-text-subtle mb-4 text-2xs">{periodLabel}</p>

      {!stats.hasData ? (
        /* Пустое состояние: так и пишем, а не рисуем нули (§правило 2). */
        <p className="text-text-muted text-sm">
          За этот период ассистент не работал: ни одной попытки ответить, ни одного сообщения.
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          {/* ── автономность */}
          <div>
            <h3 className="text-text-muted mb-2 text-2xs">Автономность</h3>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Figure
                label="Закрыл сам"
                value={autonomy.rate === null ? "—" : formatPercent(autonomy.rate)}
                hint={
                  autonomy.total === 0
                    ? "агент не отвечал"
                    : `${formatNumber(autonomy.closedByAgent)} из ${formatNumber(autonomy.total)} разговоров`
                }
                title="Разговор считается закрытым, только если сутки после ответа агента не вмешивался сотрудник, не заводилась эскалация и пациент не переспросил в ближайшие два часа."
              />
              <Figure
                label="Ушло человеку"
                value={formatNumber(autonomy.wentToHuman)}
                hint="агент не справился или тема не его"
              />
              <Figure
                label="Эскалаций"
                value={formatNumber(stats.escalations.reduce((s, e) => s + e.count, 0))}
                hint={`не разобрано ${formatNumber(stats.escalationAck.unacknowledged)}`}
              />
              <Speed
                label="Разбор эскалации"
                stats={stats.escalationAck}
                title="От уведомления администратору до отметки «взял в работу». Это метрика администратора и работоспособности push, а не качества агента."
              />
            </div>
          </div>

          {/* ── что агент сделал: по реальной схеме работы */}
          <div>
            <h3 className="text-text-muted mb-2 text-2xs">Что агент сделал</h3>
            {/*
              «Закрыл сам» — узкая метрика: она считает разговоры, после
              которых никто ни во что не вмешался. По устройству клиники так и
              не должно быть часто: расписанием агент не распоряжается, время
              называет администратор. Здесь — вторая половина картины: сколько
              человек агент довёл до готовой заявки и сколько таких заявок
              стали настоящими записями.
            */}
            <div className="border-border bg-surface rounded-xl border px-4 py-4">
              <Donut
                total={assist.total}
                totalLabel="разговоров"
                empty="за период агент не отвечал ни в одном разговоре"
                slices={[
                  {
                    label: "Оформил заявку и передал",
                    value: assist.prepared,
                    hint: "довёл до данных для записи, дальше администратор",
                  },
                  {
                    label: "Ответил без заявки",
                    value: Math.max(assist.total - assist.prepared, 0),
                    hint: "справочный разговор: цена, адрес, часы",
                  },
                ]}
              />
              <p className="text-text-muted mt-3 text-xs leading-relaxed">
                {assist.prepared === 0
                  ? "Готовых заявок за период не было: агент отвечал справкой, до данных для записи разговор не доходил."
                  : `Из ${formatNumber(assist.prepared)} оформленных заявок записью стали ` +
                    `${formatNumber(assist.booked)}` +
                    (assist.bookRate === null ? "" : ` — ${formatPercent(assist.bookRate)}`) +
                    ". Заявка считается оформленной, если агент ответил, пациент прислал данные для записи и разговор перешёл человеку."}
              </p>
            </div>
          </div>

          {/* ── надёжность */}
          <div>
            <h3 className="text-text-muted mb-2 text-2xs">Надёжность</h3>
            {/*
              Прочерк без даты читается как поломка, а означает «журнала тогда
              ещё не было». Журнал попыток появился позже самой системы.
            */}
            <p className="text-text-subtle mb-2 text-2xs">
              {stats.logSince
                ? `журнал попыток ведётся с ${logDay.format(stats.logSince)}`
                : "журнал попыток пуст: обращений к модели ещё не было"}
            </p>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Figure
                label="Успешных попыток"
                value={rel.okRate === null ? "—" : formatPercent(rel.okRate)}
                hint={
                  rel.attempts === 0
                    ? "обращений к модели не было"
                    : `${formatNumber(rel.ok)} из ${formatNumber(rel.attempts)}`
                }
                title="Эскалации и намеренное молчание сюда не входят: это штатная работа, а не отказ."
              />
              <Figure
                label="Таймауты"
                value={rel.timeoutRate === null ? "—" : formatPercent(rel.timeoutRate)}
                hint={`ошибок провайдера ${formatNumber(rel.providerError)}, пустых ответов ${formatNumber(rel.emptyResponse)}`}
              />
              <Figure
                label="Спасено повтором"
                value={formatNumber(rel.savedByRetry)}
                hint="без второй попытки пациент ждал бы администратора"
              />
              <Figure
                label="Задержка модели"
                value={rel.p50 === null ? "—" : duration(rel.p50)}
                hint={rel.p95 === null ? "медиана · 95-й перцентиль неизвестен" : `медиана · 95-й: ${duration(rel.p95)}`}
              />
            </div>
          </div>

          {/* ── скорость ответа */}
          <div>
            <h3 className="text-text-muted mb-2 text-2xs">Скорость первого ответа</h3>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Speed label="Ассистент" stats={rt.agent} />
              <Speed
                label="Человек в рабочие часы"
                stats={rt.staffWorkingHours}
                title="Рабочие часы берутся из «Настройки → Клиника», а не из константы."
              />
              <Speed label="Человек вне часов" stats={rt.staffAfterHours} />
              <Figure
                label="Без ответа"
                value={formatNumber(rt.unanswered)}
                hint={
                  rt.anomalies > 0
                    ? `обращений · отброшено аномалий ${formatNumber(rt.anomalies)}`
                    : "обращений остались без ответа"
                }
                title="Обращения, на которые никто не ответил. В медиану не входят: иначе молчание улучшало бы показатель."
              />
            </div>
          </div>

          {/* ── эскалации по поводам */}
          {stats.escalations.length > 0 ? (
            <div>
              <h3 className="text-text-muted mb-2 text-2xs">Почему звали человека</h3>
              {/*
                Круг отвечает на вопрос «чего больше», таблица — «сколько и как
                быстро разобрали». Это разные вопросы, и одно другое не
                заменяет.
              */}
              <div className="border-border bg-surface mb-3 rounded-xl border px-4 py-4">
                <Donut
                  totalLabel="эскалаций"
                  slices={stats.escalations.map((e) => ({
                    label: REASON_LABEL[e.reason] ?? e.reason,
                    value: e.count,
                  }))}
                />
              </div>
              <div className="-mx-1 overflow-x-auto px-1">
                <table className="w-full min-w-[440px] border-collapse text-sm">
                  <thead>
                    <tr className="text-text-subtle text-left text-2xs">
                      <th className="py-2 pr-3 font-normal">Повод</th>
                      <th className="py-2 pr-3 text-right font-normal">Сколько</th>
                      <th className="py-2 pr-3 text-right font-normal">Доля</th>
                      <th className="py-2 pr-3 text-right font-normal">Медиана до разбора</th>
                      <th className="py-2 text-right font-normal">Не разобрано</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.escalations.map((e) => (
                      <tr key={e.reason} className="border-border-soft border-t">
                        <td className="py-2 pr-3">{REASON_LABEL[e.reason] ?? e.reason}</td>
                        <td className="num py-2 pr-3 text-right">{formatNumber(e.count)}</td>
                        <td className="num py-2 pr-3 text-right">{formatPercent(e.share)}</td>
                        <td className="num py-2 pr-3 text-right">{duration(e.medianToAckMs)}</td>
                        <td className="num py-2 text-right">{formatNumber(e.unresolved)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {/* ── снятое ожидание: работает без журнала тем */}
          <div>
            <h3 className="text-text-muted mb-2 text-2xs">Сколько пациенты не ждали</h3>
            {/*
              Вторая мера пользы, и она из двух измеренных медиан, без единой
              придуманной величины: столько отвечает агент и столько ждали бы
              человека в рабочие часы. Ночное ожидание в сравнение не берём —
              агент работает круглосуточно, человек нет, и это завысило бы
              пользу в разы. Оценка снизу, так и подписано.
            */}
            <div className="border-border bg-surface rounded-xl border px-4 py-4">
              {!waiting.enough ? (
                <p className="text-text-muted text-sm leading-relaxed">
                  {waiting.answers === 0
                    ? "Агент ещё ни разу не отвечал первым — считать нечего."
                    : `Не с чем сравнить: ручных первых ответов в рабочие часы всего ${formatNumber(waiting.manualSamples)}, нужно хотя бы пять. Оценка на двух наблюдениях хуже честного «недостаточно данных».`}
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <Figure
                      label="Снято ожидания"
                      value={hours(waiting.savedMs)}
                      hint={`по ${formatNumber(waiting.answers)} обращениям`}
                      title="Разница между тем, сколько отвечает агент, и тем, сколько ждали бы человека в рабочие часы, умноженная на число обращений, где агент ответил первым."
                    />
                    <Figure
                      label="Агент отвечает за"
                      value={duration(waiting.medianAgentMs)}
                      hint="медиана первого ответа"
                    />
                    <Figure
                      label="Человека ждали бы"
                      value={duration(waiting.medianManualMs)}
                      hint={`медиана по ${formatNumber(waiting.manualSamples)} ответам в рабочие часы`}
                    />
                    <Figure
                      label="На одно обращение"
                      value={duration(waiting.perAnswerMs)}
                      hint="настолько быстрее"
                    />
                  </div>
                  <p className="text-text-subtle mt-2.5 text-2xs leading-relaxed">
                    Оценка снизу: сравниваем с ответом человека в РАБОЧИЕ часы. Ночью и в
                    выходные разница больше, но брать её в расчёт значило бы завысить пользу.
                  </p>
                </>
              )}
            </div>
          </div>

          {/* ── экономия времени */}
          <div>
            <h3 className="text-text-muted mb-2 text-2xs">Сэкономленное время администратора</h3>
            {savings.byTopic.length === 0 ? (
              <p className="text-text-muted text-sm">
                Посчитать не по чему: ни по одной теме не набралось пяти ручных ответов
                администратора для сравнения.
                {savings.skippedTopics.length > 0
                  ? ` Тем без базы сравнения: ${formatNumber(savings.skippedTopics.length)}.`
                  : ""}
              </p>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <Figure
                    label="Сэкономлено"
                    value={hours(savings.savedMs)}
                    hint={`по ${formatNumber(savings.byTopic.length)} темам с базой сравнения`}
                    title="Закрытые агентом разговоры, умноженные на медиану РУЧНОГО ответа по той же теме за 90 дней. Ручной ответ обрезан получасом сверху: дольше — это уже не время написания."
                  />
                  {/*
                    Встречное число рядом, а не под спойлером: экономия без него
                    вводит владельца в заблуждение — агент, отдавший половину
                    разговоров, «сэкономил» время, которое сам же и потратил
                    чужими руками.
                  */}
                  <Figure
                    label="Потрачено на эскалации"
                    value={hours(savings.escalationCostMs)}
                    hint={`${formatNumber(savings.escalations)} разговоров разбирали люди`}
                    title="Время от уведомления до отметки «взял в работу» по разобранным эскалациям."
                  />
                </div>

                <div className="-mx-1 mt-3 overflow-x-auto px-1">
                  <table className="w-full min-w-[440px] border-collapse text-sm">
                    <thead>
                      <tr className="text-text-subtle text-left text-2xs">
                        <th className="py-2 pr-3 font-normal">Тема</th>
                        <th className="py-2 pr-3 text-right font-normal">Закрыто</th>
                        <th className="py-2 pr-3 text-right font-normal">Ручной ответ</th>
                        <th className="py-2 text-right font-normal">Сэкономлено</th>
                      </tr>
                    </thead>
                    <tbody>
                      {savings.byTopic.map((t) => (
                        <tr key={t.topic} className="border-border-soft border-t">
                          <td className="py-2 pr-3">{t.topic}</td>
                          <td className="num py-2 pr-3 text-right">{formatNumber(t.closed)}</td>
                          <td
                            className="num py-2 pr-3 text-right"
                            title={`медиана по ${t.samples} ручным ответам`}
                          >
                            {duration(t.manualMedianMs)}
                          </td>
                          <td className="num py-2 text-right">{hours(t.savedMs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {savings.skippedTopics.length > 0 ? (
                  <p className="text-text-subtle mt-2 text-2xs">
                    Недостаточно данных для {formatNumber(savings.skippedTopics.length)} тем: по ним
                    администратор отвечал руками меньше пяти раз, и сравнивать не с чем. Их вклад в
                    экономию не додумывается.
                  </p>
                ) : null}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
