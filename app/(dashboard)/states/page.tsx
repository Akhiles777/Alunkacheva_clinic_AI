import { CabinetCard } from "../_components/cabinet-card";
import { FreeWindows } from "../_components/free-windows";
import { AttentionList, InquiryList } from "../_components/today-lists";
import { notFound } from "next/navigation";
import { getToday, type CabinetNow, type FreeWindowRow } from "@/app/_data/today";
import { AgentSection } from "../owner/agent-section";
import type { AgentStats } from "@/lib/server/agent-stats";
import type { SourceStat } from "@/lib/metrics/types";
import { SourcePicker } from "../_components/visit-source";
import { GapsBlock, type GapsData } from "../settings/assistant/gaps-block";

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


/**
 * Фикстуры раздела «Работа ассистента».
 *
 * Пустые значения здесь — null, а не ноль: именно так их отдаёт расчёт, и
 * именно эту разницу проверяет экран.
 */
const NO_STATS = { medianMs: null, meanMs: null, count: 0 };
const NO_SPEED = {
  agent: NO_STATS,
  staffWorkingHours: NO_STATS,
  staffAfterHours: NO_STATS,
  unanswered: 0,
  anomalies: 0,
  byChannel: [],
  byStaff: [],
};
const NO_RELIABILITY = {
  attempts: 0,
  ok: 0,
  timeout: 0,
  providerError: 0,
  emptyResponse: 0,
  okRate: null,
  timeoutRate: null,
  providerErrorRate: null,
  p50: null,
  p95: null,
  savedByRetry: 0,
  suppressed: 0,
};

const AGENT_EMPTY: AgentStats = {
  hasData: false,
  reliability: NO_RELIABILITY,
  autonomy: { total: 0, closedByAgent: 0, wentToHuman: 0, rate: null },
  escalations: [],
  escalationAck: { ...NO_STATS, unacknowledged: 0 },
  responseTime: NO_SPEED,
  savings: { savedMs: 0, byTopic: [], skippedTopics: [], escalations: 0, escalationCostMs: 0 },
};

const AGENT_NO_BASE: AgentStats = {
  hasData: true,
  reliability: {
    ...NO_RELIABILITY,
    attempts: 24,
    ok: 22,
    timeout: 2,
    okRate: 22 / 24,
    timeoutRate: 2 / 24,
    providerErrorRate: 0,
    p50: 2400,
    p95: 9100,
    savedByRetry: 2,
    suppressed: 7,
  },
  autonomy: { total: 31, closedByAgent: 19, wentToHuman: 12, rate: 19 / 31 },
  escalations: [
    { reason: "MEDICAL_QUESTION", count: 7, share: 0.58, medianToAckMs: 11 * 60_000, unresolved: 1 },
    { reason: "MISUNDERSTOOD", count: 5, share: 0.42, medianToAckMs: null, unresolved: 5 },
  ],
  escalationAck: { medianMs: 11 * 60_000, meanMs: 19 * 60_000, count: 6, unacknowledged: 6 },
  responseTime: {
    ...NO_SPEED,
    agent: { medianMs: 2400, meanMs: 3100, count: 22 },
    staffWorkingHours: { medianMs: 7 * 60_000, meanMs: 14 * 60_000, count: 18 },
    staffAfterHours: { medianMs: 9 * 3_600_000, meanMs: 11 * 3_600_000, count: 4 },
    unanswered: 3,
    anomalies: 1,
  },
  // Темы есть, но ручных ответов по ним меньше пяти — считать не по чему.
  savings: {
    savedMs: 0,
    byTopic: [],
    skippedTopics: [
      { topic: "Подготовка к внутривенному капельному введению растворов", closed: 9, samples: 3 },
      { topic: "Парковка", closed: 4, samples: 1 },
    ],
    escalations: 12,
    escalationCostMs: 68 * 60_000,
  },
};

const AGENT_BIG: AgentStats = {
  hasData: true,
  reliability: {
    ...NO_RELIABILITY,
    attempts: 4820,
    ok: 4611,
    timeout: 173,
    providerError: 31,
    emptyResponse: 5,
    okRate: 4611 / 4820,
    timeoutRate: 173 / 4820,
    providerErrorRate: 31 / 4820,
    p50: 2700,
    p95: 11400,
    savedByRetry: 118,
    suppressed: 1204,
  },
  autonomy: { total: 1372, closedByAgent: 1043, wentToHuman: 329, rate: 1043 / 1372 },
  escalations: [
    { reason: "MEDICAL_QUESTION", count: 148, share: 0.45, medianToAckMs: 9 * 60_000, unresolved: 12 },
    { reason: "PATIENT_REQUEST", count: 101, share: 0.31, medianToAckMs: 14 * 60_000, unresolved: 7 },
    { reason: "MISUNDERSTOOD", count: 80, share: 0.24, medianToAckMs: 26 * 60_000, unresolved: 21 },
  ],
  escalationAck: { medianMs: 12 * 60_000, meanMs: 41 * 60_000, count: 289, unacknowledged: 40 },
  responseTime: {
    ...NO_SPEED,
    agent: { medianMs: 2700, meanMs: 3400, count: 4611 },
    staffWorkingHours: { medianMs: 6 * 60_000, meanMs: 21 * 60_000, count: 1284 },
    staffAfterHours: { medianMs: 11 * 3_600_000, meanMs: 13 * 3_600_000, count: 402 },
    unanswered: 96,
    anomalies: 4,
  },
  savings: {
    savedMs: 74 * 3_600_000,
    byTopic: [
      { topic: "Адрес и как добраться", closed: 412, samples: 61, manualMedianMs: 4 * 60_000, savedMs: 27 * 3_600_000 },
      { topic: "Подготовка к приёму остеопата", closed: 318, samples: 44, manualMedianMs: 5 * 60_000, savedMs: 26 * 3_600_000 },
      { topic: "Часы работы", closed: 289, samples: 38, manualMedianMs: 4 * 60_000, savedMs: 21 * 3_600_000 },
    ],
    skippedTopics: [{ topic: "Противопоказания к БОС-терапии", closed: 24, samples: 2 }],
    escalations: 329,
    escalationCostMs: 63 * 3_600_000,
  },
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

/**
 * Разрез по источникам на день внедрения: источник известен у двух десятков
 * записей из семисот сорока одной. Строка «неизвестен» — самая большая, и
 * прятать её нельзя.
 */
const SOURCES_MOSTLY_UNKNOWN: SourceStat[] = [
  { code: "whatsapp", title: "WhatsApp", inquiries: 42, booked: 14, share: 1 },
  { code: "instagram", title: "Instagram", inquiries: 9, booked: 4, share: 0.21 },
  { code: "telegram", title: "Telegram", inquiries: 3, booked: 3, share: 0.07 },
  { code: "none", title: "Источник неизвестен", inquiries: 0, booked: 720, share: 0, unknown: true },
];

/** Пробелов нет: эскалаций «нечем ответить» за срок не было вовсе. */
const GAPS_EMPTY: GapsData = { clusters: [], total: 0, withoutQuestion: 0, windowDays: 90 };

/**
 * Боевая картина: один вопрос повторяется, второй — медицинский, а к части
 * эскалаций вопрос не нашёлся. Все три случая должны читаться по-разному.
 */
const GAPS_FULL: GapsData = {
  total: 14,
  withoutQuestion: 3,
  windowDays: 90,
  clusters: [
    {
      key: "адрес-клини",
      title: "подскажите адрес клиники",
      count: 6,
      lastAt: "2026-09-02T09:15:00.000Z",
      reasons: ["MISUNDERSTOOD"],
      medical: false,
      questions: [
        { id: "q1", text: "подскажите адрес клиники", at: "2026-09-02T09:15:00.000Z" },
        { id: "q2", text: "а где вы находитесь, как доехать от вокзала", at: "2026-08-30T14:02:00.000Z" },
      ],
      answers: [
        {
          text: "Мы на Ленина 1, второй этаж, вход со двора. Парковка есть перед зданием.",
          at: "2026-09-02T09:22:00.000Z",
          authorName: "Мила",
        },
      ],
    },
    {
      key: "беремен-капельниц",
      title: "можно ли капельницу при беременности",
      count: 3,
      lastAt: "2026-08-28T11:40:00.000Z",
      reasons: ["MEDICAL_QUESTION"],
      medical: true,
      questions: [
        { id: "q3", text: "можно ли капельницу при беременности", at: "2026-08-28T11:40:00.000Z" },
      ],
      answers: [
        {
          text: "Вам с вашим сроком лучше не надо, приходите после родов.",
          at: "2026-08-28T12:10:00.000Z",
          authorName: "Гаджи Абдурахманович Алунукачев",
        },
      ],
    },
    {
      key: "оплат-рассроч",
      title: "можно ли оплатить курс частями",
      count: 2,
      lastAt: "2026-08-20T08:05:00.000Z",
      reasons: ["MISUNDERSTOOD"],
      medical: false,
      questions: [
        { id: "q4", text: "можно ли оплатить курс частями", at: "2026-08-20T08:05:00.000Z" },
      ],
      answers: [],
    },
  ],
};

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

      {/*
        «Работа ассистента» — три состояния, из-за которых раздел легко читать
        неверно: пустой период, нехватка базы для сравнения и крупные числа.
        Данные ниже выдуманы намеренно, как и всё на этом экране.
      */}
      <Case title="Ассистент: за период данных нет" note="пусто показываем словами, а не нулями">
        <AgentSection stats={AGENT_EMPTY} periodLabel="за 30 дней · 04.08 — 03.09" />
      </Case>

      <Case
        title="Ассистент: базы для сравнения не хватило"
        note="экономию не считаем и говорим почему"
      >
        <AgentSection stats={AGENT_NO_BASE} periodLabel="за 30 дней · 04.08 — 03.09" />
      </Case>

      <Case title="Ассистент: крупные числа" note="четырёхзначные значения и длинные темы">
        <AgentSection stats={AGENT_BIG} periodLabel="за 90 дней · 05.06 — 03.09" />
      </Case>

      {/*
        Источник визита в трёх состояниях. Они выглядят по-разному не для
        красоты: «Instagram» и «Instagram · из переписки» — разные утверждения,
        и администратор должен видеть, правит он догадку системы или чужой
        ответ. Справочник на этом экране не грузится — нажатие покажет строку
        загрузки, и это тоже состояние.
      */}
      <Case title="Источник визита" note="проставлен человеком, выведен из переписки, неизвестен">
        <div className="border-border bg-surface flex max-w-[560px] flex-col gap-3 rounded-xl border p-5">
          <SourcePicker
            state={{ code: "instagram", title: "Instagram", confidence: "MANUAL" }}
            onPick={() => {}}
          />
          <SourcePicker
            state={{ code: "whatsapp", title: "WhatsApp", confidence: "DERIVED" }}
            onPick={() => {}}
          />
          <SourcePicker state={{ code: null, title: null, confidence: "UNKNOWN" }} onPick={() => {}} />
          {/* Длинное название источника не должно ломать строку визита. */}
          <SourcePicker
            state={{
              code: "referral",
              title: "Рекомендация коллеги из соседней клиники",
              confidence: "MANUAL",
            }}
            onPick={() => {}}
          />
          {/* Только чтение: чужой день, отметки там не ставят. */}
          <SourcePicker
            state={{ code: "phone", title: "Звонок", confidence: "MANUAL" }}
            readOnly
            onPick={() => {}}
          />
        </div>
      </Case>

      {/*
        Разрез по источникам, когда источник неизвестен почти везде. Это
        боевое состояние на день внедрения: 741 визит из 741 без источника.
        Строка «неизвестен» стоит наравне с остальными и со своим числом —
        иначе доли считаются от одних опознанных записей и «WhatsApp — 100%»
        означает одну запись из семисот сорока одной.
      */}
      <Case title="Источники: почти всё неизвестно" note="строка «неизвестен» не прячется">
        <div className="border-border bg-surface max-w-[560px] rounded-xl border p-5">
          <ul className="flex flex-col gap-3">
            {SOURCES_MOSTLY_UNKNOWN.map((s) => (
              <li key={s.code} className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-3">
                <span className={`truncate text-sm ${s.unknown ? "text-text-muted" : ""}`}>
                  {s.title}
                </span>
                <div className="flex items-center gap-3">
                  <div className="bg-list-gap rounded-pill h-2 flex-1 overflow-hidden">
                    <div className="bg-accent rounded-pill h-full" style={{ width: `${s.share * 100}%` }} />
                  </div>
                  <span className="num text-text-subtle w-32 flex-none text-right text-2xs">
                    {s.unknown ? `${s.booked} записей · 97%` : `${s.inquiries} → ${s.booked}`}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-text-subtle mt-4 text-2xs">
            Источник у 18 из 741 записей выведен из переписки, у 3 проставлен вручную, 720 остались
            неизвестными. Неизвестный источник — это звонок или приход без переписки; догадкой он не
            заполняется.
          </p>
        </div>
      </Case>

      {/*
        Пробелы в справочнике. Пустое состояние — не «0 групп», а фраза: за
        срок ассистент ни разу не остался без ответа. Это разные утверждения.
      */}
      <Case title="Пробелы: за срок ни одного" note="пусто показываем словами">
        <div className="max-w-[820px]">
          <GapsBlock data={GAPS_EMPTY} onDraft={() => {}} />
        </div>
      </Case>

      <Case
        title="Пробелы: медицинская тема и длинные вопросы"
        note="кнопка создаёт черновик, а не запись"
      >
        <div className="max-w-[820px]">
          <GapsBlock data={GAPS_FULL} onDraft={() => {}} />
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
