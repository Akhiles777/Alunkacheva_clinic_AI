"use client";

import type { NoShowQuality } from "@/lib/server/no-show";

/**
 * Работает ли прогноз неявки.
 *
 * Одно число тут ничего не значит: «среди помеченных не пришли 30%» звучит
 * убедительно ровно до вопроса «а среди остальных сколько?». Поэтому обе доли
 * стоят рядом — если они одинаковые, прогноз бесполезен, и это должно быть
 * видно сразу, а не выясняться через полгода.
 *
 * Пока разобранных визитов мало, долей не показываем вовсе: на пяти случаях
 * они прыгают на десятки процентов и вводят в заблуждение.
 */
const MIN_FOR_SHARE = 10;

function share(part: number, whole: number): string {
  if (whole < MIN_FOR_SHARE) return "мало данных";
  return `${Math.round((part / whole) * 100)}%`;
}

const DAY = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  timeZone: "Europe/Moscow",
});

export function NoShowQualityBlock({ data, weightsSet }: { data: NoShowQuality; weightsSet: boolean }) {
  if (!weightsSet) {
    return (
      <section className="border-border bg-surface mt-4 rounded-xl border p-5">
        <h2 className="text-base font-medium">Прогноз неявки</h2>
        <p className="text-text-muted mt-2 text-sm leading-snug">
          Не включён: веса не утверждены. Они подбираются по истории самой клиники, а не берутся
          общими — на сервере это{" "}
          <span className="num">npx tsx scripts/noshow-weights.ts</span>, и после просмотра чисел{" "}
          <span className="num">--apply</span>. Пока весов нет, платформа ничего не помечает и не
          предполагает.
        </p>
      </section>
    );
  }

  const total = data.raised + data.usual;

  return (
    <section className="border-border bg-surface mt-4 rounded-xl border p-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-base font-medium">Прогноз неявки</h2>
        <span className="text-text-subtle text-2xs">
          сработал ли: доли неявок среди помеченных и среди остальных
        </span>
      </div>

      {total === 0 ? (
        <p className="text-text-muted mt-2 text-sm">
          Разобранных визитов с прогнозом ещё нет — вернитесь через неделю.
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-baseline gap-x-8 gap-y-3">
            <div>
              <div className="num text-xl leading-none font-medium">
                {share(data.raisedMissed, data.raised)}
              </div>
              <div className="text-text-subtle mt-1 text-2xs">
                не пришли из помеченных · {data.raisedMissed} из {data.raised}
              </div>
            </div>
            <div>
              <div className="num text-xl leading-none font-medium">
                {share(data.usualMissed, data.usual)}
              </div>
              <div className="text-text-subtle mt-1 text-2xs">
                не пришли из остальных · {data.usualMissed} из {data.usual}
              </div>
            </div>
            <div>
              <div className="num text-xl leading-none font-medium">
                {share(data.contactedMissed, data.contacted)}
              </div>
              <div className="text-text-subtle mt-1 text-2xs">
                не пришли из тех, кому написали · {data.contactedMissed} из {data.contacted}
              </div>
            </div>
          </div>
          <p className="text-text-subtle mt-3 text-2xs leading-snug">
            Если первое число не выше второго, прогноз не работает — веса стоит пересчитать.
            Отменённые визиты в счёт не идут: о них договорились, это не неявка.
            {data.since ? ` Журнал ведётся с ${DAY.format(new Date(data.since))}.` : ""}
          </p>
        </>
      )}
    </section>
  );
}
