import { CabinetCard } from "../_components/cabinet-card";
import { FreeWindows } from "../_components/free-windows";
import { AttentionList, InquiryList } from "../_components/today-lists";
import { notFound } from "next/navigation";
import { getToday, type CabinetNow, type FreeWindowRow } from "@/app/_data/today";

/**
 * Витрина граничных состояний — служебный экран визуальной проверки.
 * Фикстуры здесь намеренные: экран показывает, как выглядят пустой день,
 * переполненный день и крупные числа.
 *
 * В рабочей сборке страница закрыта. Она не в меню, но открывается по адресу,
 * и её выдуманные суммы (в том числе средний чек 6140 ₽) заказчик принимал за
 * настоящие показатели клиники. Данные, которые нельзя ни с чем сверить, не
 * должны быть доступны на боевом стенде.
 */
export const metadata = { title: "Состояния" };

const base = getToday();

const EMPTY_CABINETS: CabinetNow[] = base.cabinets.map((c) => ({
  ...c,
  current: null,
  nextFree: { time: "09:00", duration: "весь день", soon: c.id === "room-1" },
}));

const BIG_SUMMARY = {
  revenue: 1486000,
  avgCheck: 6140,
  scheduled: 1248,
  firstVisits: 372,
  now: "13:20",
};

const LONG_CABINET: CabinetNow = {
  id: "room-long",
  name: "Кабинет 2 (процедурный)",
  direction: "IV-терапия, забор анализов и инъекции",
  doctor: "Константинопольская-Ржевская А. В.",
  current: {
    proc: "IV-терапия",
    patient: "Константинопольская-Ржевская Аполлинария Владиславовна",
    isFirstVisit: true,
    until: "14:10",
    courseProgress: { index: 9, total: 10 },
  },
  nextFree: { time: "14:10", duration: "1 ч 30 мин", soon: true },
};

const LONG_WINDOWS: FreeWindowRow[] = [
  { id: "lw1", time: "14:10", startMinute: 850, cabName: "Кабинет 2 (процедурный)", direction: "IV-терапия, забор анализов и инъекции", duration: "1 ч 30 мин", soon: true },
  { id: "lw2", time: "16:00", startMinute: 960, cabName: "Кабинет 1", direction: "Остеопатия", duration: "1 ч", soon: false },
];

function Case({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-border border-t pt-6 pb-10">
      <div className="mb-5 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-md font-medium">{title}</h2>
        <p className="text-text-subtle text-xs">{note}</p>
      </div>
      {children}
    </section>
  );
}

export default function StatesPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <div className="flex-1 overflow-auto px-7 py-8 max-md:px-5">
      <header className="mb-9">
        <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">Состояния</h1>
        <p className="text-text-muted mt-2 max-w-[70ch] text-sm leading-relaxed">
          Служебный экран: граничные случаи проверяются здесь, а не на живых
          данных.
        </p>
      </header>

      <Case title="Пустой день" note="кабинеты свободны с открытия">
        <div className="grid grid-cols-3 gap-4 max-lg:grid-cols-1">
          {EMPTY_CABINETS.map((c) => (
            <CabinetCard key={c.id} cabinet={c} />
          ))}
        </div>
      </Case>

      <Case title="Пустые очереди" note="ни эскалаций, ни новых обращений">
        <div className="grid grid-cols-2 gap-x-8 gap-y-6 max-lg:grid-cols-1">
          <AttentionList items={[]} />
          <InquiryList items={[]} />
        </div>
      </Case>

      <Case title="Все кабинеты заняты" note="свободных окон нет — это тоже ответ">
        <FreeWindows windows={[]} />
      </Case>

      <Case title="Четырёхзначные числа" note="квартальные значения в дневной шапке">
        <div className="text-text-muted flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
          <span>
            Выручка{" "}
            <b className="num text-text font-medium">
              {BIG_SUMMARY.revenue.toLocaleString("ru-RU")} ₽
            </b>
          </span>
          <span aria-hidden className="sep-dot" />
          <span>
            <b className="num text-text font-medium">{BIG_SUMMARY.scheduled.toLocaleString("ru-RU")}</b>{" "}
            записей
          </span>
          <span aria-hidden className="sep-dot" />
          <span>
            <b className="num text-text font-medium">{BIG_SUMMARY.firstVisits}</b> первичных
          </span>
        </div>
      </Case>

      <Case title="Длинные фамилии" note="двойная с отчеством в карточке и окнах">
        <div className="grid grid-cols-3 gap-4 max-lg:grid-cols-1">
          <CabinetCard cabinet={LONG_CABINET} />
          <div className="col-span-2 max-lg:col-span-1">
            <FreeWindows windows={LONG_WINDOWS} />
          </div>
        </div>
      </Case>

      <Case title="Загрузка" note="каркас на месте, дышит серым">
        <div className="grid grid-cols-3 gap-4 max-lg:grid-cols-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className="border-border bg-surface rounded-xl border p-[18px]">
              <div className="skeleton h-4 w-28 rounded-sm" />
              <div className="skeleton mt-2 h-3 w-24 rounded-sm" />
              <div className="border-border-soft my-[15px] border-t" />
              <div className="skeleton h-4 w-40 rounded-sm" />
              <div className="skeleton mt-4 h-[70px] w-full rounded-lg" />
            </div>
          ))}
        </div>
      </Case>

      <Case title="Ошибка" note="что не прочиталось и что делать">
        <div className="border-border bg-surface max-w-[560px] rounded-xl border p-5">
          <p className="text-md font-medium">Данные смены не загрузились</p>
          <p className="text-text-muted mt-2 text-sm leading-relaxed">
            Экран читает локальную проекцию YCLIENTS. Записи и деньги в самом
            YCLIENTS не пострадали.
          </p>
          <button
            type="button"
            className="bg-accent text-accent-contrast hover:bg-accent-hover mt-5 rounded-md px-4 py-2 text-sm font-medium"
          >
            Загрузить снова
          </button>
        </div>
      </Case>
    </div>
  );
}
