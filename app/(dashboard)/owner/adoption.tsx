"use client";

import { useState } from "react";
import { resolveProblem } from "../_components/usage-actions";
import type { AdoptionView } from "@/lib/server/adoption";

/**
 * Перешли ли мы в систему.
 *
 * Один вопрос, ради которого делался весь цикл: администратор отвечает
 * пациентам отсюда — или по-прежнему из WhatsApp на телефоне клиники.
 * Сообщения с телефона приходят к нам вебхуком, поэтому обе половины видны и
 * сравнимы, а доля считается честно.
 *
 * Число не про сотрудника, а про инструмент: не растёт — значит в платформе
 * чего-то не хватает, и разбираться надо с ней. Так это и подписано.
 */
export function Adoption({ data }: { data: AdoptionView }) {
  const [problems, setProblems] = useState(data.problems);
  const weeks = data.weeks;
  const last = weeks[weeks.length - 1];
  const first = weeks.find((w) => w.share !== null);

  return (
    <section className="border-border bg-surface mt-4 rounded-xl border p-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-base font-medium">Перешли ли в систему</h2>
        <span className="text-text-subtle text-2xs">
          доля ответов пациентам, отправленных отсюда, а не с телефона клиники
        </span>
      </div>

      {last?.share === null ? (
        <p className="text-text-muted mt-3 text-sm">
          За последнюю неделю ручных ответов не было — сравнивать нечего.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <div>
            <div className="num text-xl leading-none font-medium">
              {Math.round((last?.share ?? 0) * 100)}%
            </div>
            <div className="text-text-subtle mt-1 text-2xs">за последнюю неделю</div>
          </div>
          <div className="text-text-muted text-sm">
            из платформы <span className="num">{last?.ours ?? 0}</span> · с телефона{" "}
            <span className="num">{last?.phone ?? 0}</span>
          </div>
          {first && first !== last && first.share !== null && last?.share !== null ? (
            <div className="text-text-muted text-sm">
              было <span className="num">{Math.round(first.share * 100)}%</span> в неделю{" "}
              {first.label}
            </div>
          ) : null}
        </div>
      )}

      {/* По неделям: за день доля прыгает от одного разговора. */}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="text-text-subtle border-border-soft border-b text-left text-2xs">
              <th className="py-1.5 font-normal">Неделя</th>
              <th className="py-1.5 text-right font-normal">Из платформы</th>
              <th className="py-1.5 text-right font-normal">С телефона</th>
              <th className="py-1.5 text-right font-normal">Доля</th>
              <th className="py-1.5 text-right font-normal">Первый ответ</th>
              <th className="py-1.5 text-right font-normal">Переписок</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.label} className="border-border-soft border-b last:border-b-0">
                <td className="py-1.5">{w.label}</td>
                <td className="num py-1.5 text-right">{w.ours}</td>
                <td className="num py-1.5 text-right">{w.phone}</td>
                <td className="num py-1.5 text-right">
                  {/* Ответов не было — прочерк, а не ноль: это разные вещи. */}
                  {w.share === null ? "—" : `${Math.round(w.share * 100)}%`}
                </td>
                <td className="num py-1.5 text-right">
                  {w.replyMinutes === null
                    ? "—"
                    : w.replyMinutes < 60
                      ? `${Math.round(w.replyMinutes)} мин`
                      : `${(w.replyMinutes / 60).toFixed(1).replace(".", ",")} ч`}
                </td>
                <td className="num py-1.5 text-right">{w.dialogs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-text-subtle mt-2 text-2xs leading-snug">
        Отметка «ушло из платформы» проставляется с {data.exactFrom}; более ранние недели
        считаются по автору сообщения — признак косвенный, и рост доли на границе может
        означать смену способа счёта, а не переход.
      </p>

      {/* Что осталось невостребованным. Ноль — повод посмотреть, видно ли это вообще. */}
      <div className="border-border-soft mt-4 border-t pt-4">
        <div className="text-text-subtle mb-2 text-2xs">Чем пользуются — за 30 дней</div>
        <ul className="flex flex-wrap gap-x-5 gap-y-1.5">
          {data.features.map((f) => (
            <li key={f.key} className="text-sm">
              <span className="text-text-muted">{f.label}</span>{" "}
              <span className={`num ${f.count === 0 ? "text-accent-text" : ""}`}>{f.count}</span>
            </li>
          ))}
        </ul>
        <p className="text-text-subtle mt-1.5 text-2xs">
          Ноль означает, что приёмом не пользуются ни разу: стоит проверить, видно ли его на
          экране, — а не убирать возможность.
        </p>
      </div>

      {problems.length > 0 ? (
        <div className="border-border-soft mt-4 border-t pt-4">
          <div className="text-text-subtle mb-2 text-2xs">
            Сообщения о проблемах — от сотрудников, кнопкой «Что-то не так?»
          </div>
          <ul className="flex flex-col gap-2">
            {problems.map((p) => (
              <li key={p.id} className="flex items-baseline gap-2 text-sm">
                <span className="text-text-subtle num flex-none text-2xs">{p.at}</span>
                <span className="min-w-0 flex-1">
                  {p.text}
                  {p.screen ? (
                    <span className="text-text-subtle text-2xs"> · экран {p.screen}</span>
                  ) : null}
                  {p.author ? <span className="text-text-subtle text-2xs"> · {p.author}</span> : null}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    void resolveProblem(p.id).then(() =>
                      setProblems((list) => list.filter((x) => x.id !== p.id)),
                    )
                  }
                  className="text-text-subtle hover:text-text flex-none text-2xs"
                >
                  разобрано
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
