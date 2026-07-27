import type { Patient } from "@/app/_data/patients";
import { formatMoney } from "@/lib/format";

/**
 * Карточка пациента — ОДНА вёрстка, три места: колонка 320px в «Диалогах»,
 * панель-оверлей поверх других экранов, полная страница /patients/[id].
 * Компонент рендерит только содержимое и тянется по ширине контейнера;
 * рамку (колонка / оверлей / страница) задаёт обёртка.
 */
function initials(name: string): string {
  return name
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("");
}

const VISIT_STATUS: Record<Patient["visits"][number]["status"], { label: string; cls: string }> = {
  arrived: { label: "пришёл", cls: "text-text-muted" },
  no_show: { label: "не пришёл", cls: "text-text-subtle line-through" },
  cancelled: { label: "отменён", cls: "text-text-subtle line-through" },
  planned: { label: "запланирован", cls: "text-accent-text" },
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-text-subtle mb-2.5 text-2xs">{children}</div>;
}

export function PatientCardBody({ patient }: { patient: Patient }) {
  return (
    <div className="flex flex-col">
      {/* шапка */}
      <div className="flex items-start gap-3">
        <span className="bg-ink-avatar text-text-muted flex h-10 w-10 flex-none items-center justify-center rounded-full text-sm font-medium">
          {initials(patient.name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-md leading-snug font-medium">{patient.name}</div>
          <div className="num text-text-muted mt-0.5 text-sm">{patient.phonePretty}</div>
        </div>
      </div>
      {patient.tags.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {patient.tags.map((tag) => (
            <span
              key={tag}
              className="text-text-muted bg-chip rounded-sm px-2 py-0.5 text-2xs"
            >
              {tag}
            </span>
          ))}
        </div>
      ) : null}

      {/* курсы */}
      {patient.courses.length > 0 ? (
        <div className="border-border-soft mt-5 border-t pt-5">
          <SectionLabel>Курсы</SectionLabel>
          <div className="flex flex-col gap-3.5">
            {patient.courses.map((course) => {
              const pct = Math.round((course.used / course.total) * 100);
              const stalled = course.status === "stalled";
              return (
                <div key={course.id}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-sm font-medium">{course.title}</span>
                    <span className="num text-text-muted flex-none text-xs">
                      {course.used}/{course.total}
                    </span>
                  </div>
                  <div className="bg-list-gap mt-2 h-1.5 overflow-hidden rounded-pill">
                    <div
                      className="bg-accent h-full rounded-pill"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="mt-1.5 flex items-baseline justify-between gap-3">
                    <span className={`text-2xs ${stalled ? "text-accent-text font-medium" : "text-text-subtle"}`}>
                      {stalled ? "выпал из графика" : "идёт по курсу"}
                    </span>
                    <span className="text-text-subtle text-2xs">последний визит {course.lastVisit}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* визиты */}
      <div className="border-border-soft mt-5 border-t pt-5">
        <SectionLabel>История визитов</SectionLabel>
        {patient.visits.length === 0 ? (
          <p className="text-text-subtle text-xs">Визитов ещё не было.</p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {patient.visits.map((visit) => (
              <li key={visit.id} className="flex items-baseline gap-3">
                <span className="num text-text-subtle w-16 flex-none text-xs">{visit.date}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{visit.service}</span>
                  <span className={`text-2xs ${VISIT_STATUS[visit.status].cls}`}>
                    {visit.doctor} · {VISIT_STATUS[visit.status].label}
                  </span>
                </span>
                {visit.amount > 0 ? (
                  <span className="num text-text-muted flex-none text-xs">
                    {formatMoney(visit.amount)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* переписка */}
      {patient.messages.length > 0 ? (
        <div className="border-border-soft mt-5 border-t pt-5">
          <SectionLabel>Переписка</SectionLabel>
          <ul className="flex flex-col gap-2">
            {patient.messages.slice(-3).map((m) => (
              <li key={m.id} className="flex items-baseline gap-2">
                <span className="text-text-subtle w-14 flex-none text-2xs">
                  {m.from === "patient" ? "пациент" : m.from === "bot" ? "агент" : "вы"}
                </span>
                <span className="flex-1 text-xs leading-snug">{m.text}</span>
                <span className="num text-text-subtle flex-none text-2xs">{m.at}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* источник */}
      <div className="border-border-soft text-text-subtle mt-5 border-t pt-4 text-2xs">
        Первое обращение: {patient.source} · {patient.firstSeen}
      </div>
    </div>
  );
}
