"use client";

import Link from "next/link";
import { useState } from "react";
import { capitalizeFirst } from "@/lib/metrics/digest";
import type { DigestView } from "./digest-actions";

/**
 * «Сводка недели» — то, о чём стоит спросить, а не ещё один дашборд.
 *
 * Три-пять наблюдений с числами и ссылками. Всё остальное на этом экране уже
 * есть, и повторять его здесь значило бы превратить сводку в оглавление, а
 * оглавления не читают.
 *
 * Каждое наблюдение показывает своё основание: текущее число и обычное для
 * клиники. Догадка о причине стоит отдельной строкой и подписана как догадка —
 * «возможно». Смешивать её с фактом нельзя: владелец примет объяснение за
 * разобранный случай и смотреть не пойдёт.
 */

const when = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  timeZone: "Europe/Moscow",
});

export function WeeklyDigestBlock({ digests }: { digests: DigestView[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const latest = digests[0] ?? null;
  const older = digests.slice(1);

  return (
    <section className="border-border bg-surface rounded-xl border p-5">
      <h2 className="text-sm font-medium">Сводка недели</h2>
      <p className="text-text-subtle mb-4 text-2xs">
        по понедельникам · что изменилось против обычного для клиники
      </p>

      {latest === null ? (
        <p className="text-text-muted text-sm leading-relaxed">
          Первая сводка придёт в понедельник утром. Она сравнивает неделю с восемью предыдущими и
          называет три-пять вещей, на которые стоит посмотреть, — а не пересчитывает всё заново.
        </p>
      ) : (
        <>
          <div className="mb-1 flex items-baseline gap-2">
            <span className="text-sm font-medium">Неделя {latest.label}</span>
            {!latest.hasBaseline ? (
              <span
                className="text-text-subtle text-2xs"
                title="Чтобы отличить изменение от обычного колебания, нужно восемь полных недель."
              >
                без сравнения
              </span>
            ) : null}
          </div>

          <div className="text-sm leading-relaxed whitespace-pre-wrap">{latest.text}</div>

          {latest.observations.length > 0 ? (
            <ul className="border-border-soft mt-4 flex flex-col gap-3 border-t pt-4">
              {latest.observations.map((o) => (
                <li key={o.key}>
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-medium">{o.title}</span>
                    {/*
                      Без `num`: моноширинные цифры нужны там, где числа стоят
                      столбцом, а здесь это предложение, и целиком в моноширине
                      оно читается как кусок кода.
                    */}
                    <span className="text-sm">{o.text}</span>
                    <Link
                      href={o.href}
                      className="text-accent-text text-2xs underline-offset-2 hover:underline"
                    >
                      посмотреть
                    </Link>
                  </div>
                  {o.hypothesis ? (
                    <div className="text-text-muted mt-0.5 text-2xs">
                      {capitalizeFirst(o.hypothesis)}
                    </div>
                  ) : null}
                  {o.note ? <div className="text-text-subtle mt-0.5 text-2xs">{o.note}</div> : null}
                </li>
              ))}
            </ul>
          ) : null}

          {!latest.byModel ? (
            <p className="text-text-subtle mt-4 text-2xs">
              Текст собран без модели — она была недоступна. Числа и наблюдения от этого не
              меняются: их считает платформа, модель только связывает их словами.
            </p>
          ) : null}
        </>
      )}

      {older.length > 0 ? (
        <div className="border-border-soft mt-5 border-t pt-4">
          <div className="text-text-subtle mb-2 text-2xs">Прошлые сводки</div>
          <ul className="flex flex-col gap-1">
            {older.map((d) => {
              const open = openId === d.id;
              return (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : d.id)}
                    className="hover:bg-hover flex w-full items-baseline gap-3 rounded-md px-2 py-1.5 text-left"
                  >
                    <span className="flex-1 text-sm">Неделя {d.label}</span>
                    <span className="text-text-subtle text-2xs">
                      {d.observations.length > 0
                        ? `наблюдений ${d.observations.length}`
                        : "без замечаний"}
                    </span>
                    <span className="text-text-subtle text-2xs">
                      {when.format(new Date(d.createdAt))}
                    </span>
                  </button>
                  {open ? (
                    <div className="text-text-muted px-2 pt-1 pb-3 text-sm leading-relaxed whitespace-pre-wrap">
                      {d.text}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
