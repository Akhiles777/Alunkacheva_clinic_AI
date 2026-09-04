"use client";

import { useEffect, useState } from "react";
import { formatMoney, formatNumber, formatPercent } from "@/lib/format";
import { getPatientDossierAction, type DossierView } from "@/app/(dashboard)/patients/actions";

/**
 * Личное дело пациента — в его карточке.
 *
 * Что клиника знает о человеке: какие услуги берёт, как часто ходит, сколько
 * принёс, как общается и что учесть в разговоре. Всё считается на нашем
 * сервере из своих данных; переписка наружу не уходит (§7 — врачебная тайна и
 * 152-ФЗ), и «разбор диалога» здесь означает счёт по правилам, а не пересказ
 * внешней модели.
 *
 * Два правила показа, из которых вырос раздел:
 *
 *   — совет без основания не показывается вовсе. Не набралось наблюдений —
 *     пишем это словами, а не выдумываем портрет: администратор понесёт наш
 *     вывод в разговор с живым человеком;
 *   — отсутствие данных показывается как отсутствие. «Средний чек 0 ₽» и
 *     «ходит раз в 0 дней» — утверждения, которых мы не делали.
 */

const CHANNEL_LABEL: Record<string, string> = {
  WHATSAPP: "WhatsApp",
  INSTAGRAM: "Instagram",
  TELEGRAM: "Telegram",
  PHONE: "звонок",
};

const CONFIDENCE_LABEL: Record<string, string> = {
  MANUAL: "",
  DERIVED: " · из переписки",
  UNKNOWN: "",
};

const day = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Europe/Moscow",
});

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-text-subtle w-[124px] flex-none text-2xs">{label}</span>
      <span className="min-w-0 flex-1 text-xs">{value}</span>
    </div>
  );
}

/** «раз в 9 дней» — так, как это произносят вслух. */
function rhythmLabel(days: number | null): string {
  if (days === null) return "—";
  return `раз в ${Math.round(days)} дн.`;
}

export function PatientDossier({ patientId }: { patientId: string }) {
  /**
   * Результат хранится вместе с идентификатором, для которого он получен.
   * Так «загружаем» выводится из состояния, а не выставляется вторым вызовом
   * внутри эффекта: лишний синхронный setState заставляет React рисовать
   * дважды на каждое открытие карточки.
   */
  const [loaded, setLoaded] = useState<{ id: string; data: DossierView | null; failed: boolean } | null>(
    null,
  );

  useEffect(() => {
    let alive = true;
    getPatientDossierAction(patientId).then(
      (d) => alive && setLoaded({ id: patientId, data: d, failed: false }),
      () => alive && setLoaded({ id: patientId, data: null, failed: true }),
    );
    return () => {
      alive = false;
    };
  }, [patientId]);

  const ready = loaded?.id === patientId ? loaded : null;
  if (!ready) {
    return <p className="text-text-subtle text-xs">Собираем личное дело…</p>;
  }
  const data = ready.data;
  if (ready.failed || !data) {
    return (
      <p className="text-text-muted text-xs">
        Личное дело не собралось. Данные пациента при этом не пострадали — обновите страницу.
      </p>
    );
  }

  return <DossierBody data={data} />;
}

/**
 * Показ отдельно от загрузки: краевые состояния проверяются на `/states`
 * фикстурами, а не подстановкой живого пациента.
 */
export function DossierBody({ data }: { data: DossierView }) {
  const { visits: v, style: s, money, rhythm } = data;
  const nothing = v.total === 0 && s.messages === 0;

  if (nothing) {
    return (
      <p className="text-text-muted text-xs leading-relaxed">
        Пока рассказывать нечего: ни визитов, ни переписки. Дело соберётся само, как только
        появится первое из двух.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3.5">
      {/* ── что берёт */}
      <div className="flex flex-col gap-1">
        <Line
          label="Визиты"
          value={
            v.total === 0
              ? "визитов не было"
              : `состоялось ${formatNumber(v.arrived)} из ${formatNumber(v.total)}` +
                (v.noShow > 0 ? ` · не пришёл ${formatNumber(v.noShow)}` : "") +
                (v.cancelled > 0 ? ` · отмен ${formatNumber(v.cancelled)}` : "")
          }
        />
        {v.unmarked > 0 ? (
          /*
            Прошедший приём без отметки исхода — не состоявшийся и не неявка
            (§8). Без этой строки числа выше выглядят полными, хотя часть
            визитов просто не разобрана.
          */
          <Line
            label="Не отмечено"
            value={`${formatNumber(v.unmarked)} прошедших приёмов без исхода — числа выше неполны`}
          />
        ) : null}
        {v.firstAt ? (
          <Line
            label="С нами с"
            value={`${day.format(new Date(v.firstAt))}${
              v.lastAt ? ` · последний визит ${day.format(new Date(v.lastAt))}` : ""
            }`}
          />
        ) : null}
        <Line
          label="Ритм"
          value={
            rhythm.medianDays === null
              ? "визитов слишком мало, чтобы говорить о ритме"
              : `${rhythmLabel(rhythm.medianDays)} · по ${formatNumber(rhythm.gaps)} промежуткам`
          }
        />
        <Line
          label="Деньги"
          value={
            money.paidVisits === 0
              ? "оплаченных приёмов не было"
              : `${formatMoney(money.total)} · средний чек ${
                  money.avgCheck === null ? "—" : formatMoney(money.avgCheck)
                } по ${formatNumber(money.paidVisits)} оплаченным`
          }
        />
        {data.source ? (
          <Line
            label="Источник"
            value={`${data.source.title ?? "неизвестен"}${CONFIDENCE_LABEL[data.source.confidence] ?? ""}`}
          />
        ) : null}
        <Line
          label="Связь"
          value={
            data.contact.channel
              ? `${CHANNEL_LABEL[data.contact.channel] ?? data.contact.channel}` +
                (data.contact.lastInboundAt
                  ? ` · писал ${day.format(new Date(data.contact.lastInboundAt))}`
                  : " · сам не писал")
              : "переписки нет"
          }
        />
      </div>

      {/* ── услуги */}
      {data.services.length > 0 ? (
        <div>
          <div className="text-text-subtle mb-1 text-2xs">Что берёт чаще</div>
          <ul className="flex flex-col gap-0.5">
            {data.services.slice(0, 5).map((x) => (
              <li key={x.title} className="flex items-baseline gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate">{x.title}</span>
                <span className="num text-text-subtle flex-none">
                  {formatNumber(x.count)} × · {formatMoney(x.revenue)}
                </span>
              </li>
            ))}
          </ul>
          {data.staff.length > 0 ? (
            <p className="text-text-subtle mt-1 text-2xs">
              Ходит к: {data.staff.map((x) => `${x.name} (${x.count})`).join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ── курсы */}
      {data.courses.length > 0 ? (
        <div>
          <div className="text-text-subtle mb-1 text-2xs">Курсы</div>
          <ul className="flex flex-col gap-0.5">
            {data.courses.map((c, i) => (
              <li key={i} className="flex items-baseline gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                <span className="num text-text-subtle flex-none">
                  {c.used}/{c.total}
                  {c.booked > 0 ? ` · записан ещё на ${c.booked}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ── как общается */}
      <div>
        <div className="text-text-subtle mb-1 text-2xs">Как общается</div>
        {!s.enough ? (
          <p className="text-text-muted text-xs leading-relaxed">
            Сообщений слишком мало ({formatNumber(s.messages)}), чтобы судить о манере. Выводы
            появятся сами — по одному-двум сообщениям их делать нельзя.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            <Line label="Сообщений" value={formatNumber(s.messages)} />
            <Line
              label="Пишет обычно"
              value={
                s.typicalHour === null
                  ? "—"
                  : `около ${String(s.typicalHour).padStart(2, "0")}:00` +
                    (s.medianLength === null
                      ? ""
                      : ` · ${Math.round(s.medianLength)} знаков в сообщении`)
              }
            />
            <Line
              label="Отвечает"
              value={
                s.medianReplyMinutes === null
                  ? "ответов на наши сообщения ещё не было"
                  : s.medianReplyMinutes < 60
                    ? `через ${Math.round(s.medianReplyMinutes)} мин (медиана)`
                    : `через ${(s.medianReplyMinutes / 60).toFixed(1).replace(".", ",")} ч (медиана)`
              }
            />
            <Line
              label="Обращение"
              value={
                s.address === "formal"
                  ? "на «вы»"
                  : s.address === "informal"
                    ? "на «ты»"
                    : "по переписке не определить"
              }
            />
            <Line
              label="Приветствие"
              value={s.greetsShare === null ? "—" : `в ${formatPercent(s.greetsShare)} сообщений`}
            />
            {s.voiceOrPhotos > 0 ? (
              <Line label="Вложения" value={`${formatNumber(s.voiceOrPhotos)} голосовых и фото`} />
            ) : null}
          </div>
        )}
      </div>

      {/* ── что учесть в разговоре */}
      {data.advice.length > 0 ? (
        <div>
          <div className="text-text-subtle mb-1 text-2xs">Что учесть в разговоре</div>
          <ul className="flex flex-col gap-1">
            {data.advice.map((a, i) => (
              <li key={i} className="text-xs leading-relaxed">
                {a.text} <span className="text-text-subtle">— {a.basis}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-text-subtle text-2xs leading-relaxed">
        Всё посчитано на сервере клиники из её же данных. Переписка во внешние сервисы не
        отправляется.
      </p>
    </div>
  );
}
