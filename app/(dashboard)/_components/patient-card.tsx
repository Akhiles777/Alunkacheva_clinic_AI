"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { getPatientRecord } from "@/app/(dashboard)/patients/actions";
import { formatMoney } from "@/lib/format";
import {
  addNote,
  addPhone,
  addRelation,
  findPatient,
  hydratePatients,
  patientCalls,
  patientTags,
  primaryPhone,
  removePhone,
  removeRelation,
  resolveNote,
  setPrimaryPhone,
  toggleWhatsapp,
  useDb,
  type NoteKind,
  type Patient,
  type RelationKind,
} from "@/app/_data/store";

/**
 * Карточка пациента — ОДНА вёрстка, три места: колонка 320px в «Диалогах»,
 * панель-оверлей, страница /patients/[id]. Читает пациента из общего стора по
 * id; при editable даёт добавлять/удалять телефоны, пометки, родство — правки
 * сразу видны во всех местах.
 */
function initials(name: string): string {
  return name
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("");
}

const NOTE_LABEL: Record<NoteKind, string> = {
  NO_CONSENT: "Нет согласия",
  INCOMPLETE_PASSPORT: "Нет паспорта",
  ATTENTION: "Внимание",
  CUSTOM: "Заметка",
};
const NOTE_KINDS: NoteKind[] = ["ATTENTION", "NO_CONSENT", "INCOMPLETE_PASSPORT", "CUSTOM"];

const RELATION_LABEL: Record<RelationKind, string> = {
  PARENT: "Родитель",
  GUARDIAN: "Опекун",
  SPOUSE: "Супруг(а)",
  OTHER: "Родственник",
};
const RELATION_KINDS: RelationKind[] = ["PARENT", "GUARDIAN", "SPOUSE", "OTHER"];

const VISIT_STATUS: Record<Patient["visits"][number]["status"], { label: string; cls: string }> = {
  arrived: { label: "пришёл", cls: "text-text-muted" },
  no_show: { label: "не пришёл", cls: "text-text-subtle line-through" },
  cancelled: { label: "отменён", cls: "text-text-subtle line-through" },
  planned: { label: "запланирован", cls: "text-accent-text" },
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-text-subtle mb-2.5 text-2xs">{children}</div>;
}

/** Время визита в поясе клиники: «13:40». */
function visitTime(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function PatientCardBody({
  patientId,
  editable = false,
}: {
  patientId: string;
  editable?: boolean;
}) {
  const db = useDb();
  const patient = db.patients.find((p) => p.id === patientId);

  /**
   * Полную запись пациента догружаем здесь, в самой карточке.
   *
   * Список пациентов историю визитов не запрашивает — тянуть её на всю базу
   * незачем. Значит любой экран, показывающий карточку, обязан догрузить её
   * сам. Прежде это делала только отдельная страница /patients/[id], а из
   * списка карточка открывается модальным окном — и в нём история визитов
   * была пуста всегда, сколько бы визитов ни лежало в базе.
   *
   * Один запрос на пациента: повторные открытия берут данные из стора.
   */
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!patientId || loadedFor.current === patientId) return;
    loadedFor.current = patientId;
    let alive = true;
    getPatientRecord(patientId)
      .then((record) => {
        if (alive && record) hydratePatients([record]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [patientId]);

  /** Дата первого обращения человеческим языком. */
  const firstContact = patient?.firstSeenAt
    ? new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Moscow" }).format(
        new Date(patient.firstSeenAt),
      )
    : patient?.firstSeen === "сегодня"
      ? "сегодня"
      : "дата неизвестна";

  const [newPhone, setNewPhone] = useState("");
  const [phoneErr, setPhoneErr] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [noteKind, setNoteKind] = useState<NoteKind>("ATTENTION");
  const [relId, setRelId] = useState("");
  const [relKind, setRelKind] = useState<RelationKind>("SPOUSE");

  if (!patient) {
    return <p className="text-text-muted text-sm">Пациент не найден.</p>;
  }

  const tags = patientTags(patient);
  const calls = patientCalls(patient.id);
  const others = db.patients.filter((p) => p.id !== patient.id);

  return (
    <div className="flex flex-col">
      {/* шапка */}
      <div className="flex items-start gap-3">
        <span className="bg-ink-avatar text-text-muted flex h-10 w-10 flex-none items-center justify-center rounded-full text-sm font-medium">
          {initials(patient.name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-md leading-snug font-medium">{patient.name}</div>
          <div className="num text-text-muted mt-0.5 text-sm">
            {primaryPhone(patient)?.pretty ?? "нет номера"}
          </div>
        </div>
      </div>
      {tags.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span key={tag} className="text-text-muted bg-chip rounded-sm px-2 py-0.5 text-2xs">
              {tag}
            </span>
          ))}
        </div>
      ) : null}

      {/* телефоны */}
      <div className="border-border-soft mt-5 border-t pt-5">
        <SectionLabel>Телефоны</SectionLabel>
        <ul className="flex flex-col gap-1.5">
          {patient.phones.map((ph) => (
            <li key={ph.id} className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={!editable}
                onClick={() => setPrimaryPhone(patient.id, ph.id)}
                aria-label={ph.isPrimary ? "Основной" : "Сделать основным"}
                className={`text-sm ${ph.isPrimary ? "text-accent-text" : "text-text-subtle hover:text-text"} ${!editable ? "cursor-default" : ""}`}
                title={ph.isPrimary ? "основной" : "сделать основным"}
              >
                {ph.isPrimary ? "★" : "☆"}
              </button>
              <span className="num flex-1 text-sm">{ph.pretty}</span>
              <button
                type="button"
                disabled={!editable}
                onClick={() => toggleWhatsapp(patient.id, ph.id)}
                className={`rounded-sm px-1.5 py-0.5 text-2xs ${
                  ph.whatsapp ? "bg-accent-tint text-accent-text" : "bg-chip text-text-subtle"
                } ${!editable ? "cursor-default" : ""}`}
                title="WhatsApp на этом номере"
              >
                WA
              </button>
              {editable && patient.phones.length > 1 ? (
                <button
                  type="button"
                  onClick={() => removePhone(patient.id, ph.id)}
                  className="text-text-subtle hover:text-text text-sm"
                  aria-label="Удалить номер"
                >
                  ×
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {editable ? (
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (addPhone(patient.id, newPhone)) {
                setNewPhone("");
                setPhoneErr(false);
              } else {
                setPhoneErr(true);
              }
            }}
          >
            <input
              value={newPhone}
              onChange={(e) => {
                setNewPhone(e.target.value);
                setPhoneErr(false);
              }}
              placeholder="+7 900 000-00-00"
              className={`border-border-input bg-surface w-full rounded-md border px-2.5 py-1.5 text-sm outline-none ${phoneErr ? "border-accent-text" : ""}`}
            />
            <button type="submit" className="border-border text-text-muted hover:bg-hover rounded-md border px-3 text-sm">
              +
            </button>
          </form>
        ) : null}
      </div>

      {/* служебные отметки */}
      <div className="border-border-soft mt-5 border-t pt-5">
        <SectionLabel>Служебные отметки</SectionLabel>
        {patient.notes.filter((n) => !n.resolved).length === 0 ? (
          <p className="text-text-subtle text-xs">Отметок нет.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {patient.notes
              .filter((n) => !n.resolved)
              .map((n) => (
                <li key={n.id} className="flex items-start gap-2">
                  <span className="text-accent-text mt-0.5 flex-none text-2xs font-medium">
                    {NOTE_LABEL[n.kind]}
                  </span>
                  <span className="flex-1 text-xs leading-snug">{n.text}</span>
                  {editable ? (
                    <button
                      type="button"
                      onClick={() => resolveNote(patient.id, n.id)}
                      className="text-text-subtle hover:text-text flex-none text-xs"
                    >
                      снять
                    </button>
                  ) : null}
                </li>
              ))}
          </ul>
        )}
        {editable ? (
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (noteText.trim()) {
                addNote(patient.id, noteKind, noteText);
                setNoteText("");
              }
            }}
          >
            <select
              value={noteKind}
              onChange={(e) => setNoteKind(e.target.value as NoteKind)}
              className="border-border-input bg-surface flex-none rounded-md border px-2 py-1.5 text-xs outline-none"
            >
              {NOTE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {NOTE_LABEL[k]}
                </option>
              ))}
            </select>
            <input
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="Текст отметки"
              className="border-border-input bg-surface w-full rounded-md border px-2.5 py-1.5 text-sm outline-none"
            />
            <button type="submit" className="border-border text-text-muted hover:bg-hover rounded-md border px-3 text-sm">
              +
            </button>
          </form>
        ) : null}
      </div>

      {/* родственные связи */}
      <div className="border-border-soft mt-5 border-t pt-5">
        <SectionLabel>Родственные связи</SectionLabel>
        {patient.relations.length === 0 ? (
          <p className="text-text-subtle text-xs">Связей нет.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {patient.relations.map((r) => {
              const rel = findPatient(r.relatedPatientId);
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-2">
                  <span className="text-text-subtle flex-none text-2xs">{RELATION_LABEL[r.kind]}</span>
                  <Link
                    href={`/patients/${r.relatedPatientId}`}
                    className="text-accent-text flex-1 truncate text-sm hover:underline"
                  >
                    {rel?.name ?? "—"}
                  </Link>
                  {editable ? (
                    <button
                      type="button"
                      onClick={() => removeRelation(patient.id, r.id)}
                      className="text-text-subtle hover:text-text text-sm"
                      aria-label="Удалить связь"
                    >
                      ×
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {editable && others.length > 0 ? (
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (relId) {
                addRelation(patient.id, relId, relKind);
                setRelId("");
              }
            }}
          >
            <select
              value={relKind}
              onChange={(e) => setRelKind(e.target.value as RelationKind)}
              className="border-border-input bg-surface flex-none rounded-md border px-2 py-1.5 text-xs outline-none"
            >
              {RELATION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {RELATION_LABEL[k]}
                </option>
              ))}
            </select>
            <select
              value={relId}
              onChange={(e) => setRelId(e.target.value)}
              className="border-border-input bg-surface w-full rounded-md border px-2 py-1.5 text-sm outline-none"
            >
              <option value="">выберите пациента</option>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <button type="submit" className="border-border text-text-muted hover:bg-hover rounded-md border px-3 text-sm">
              +
            </button>
          </form>
        ) : null}
      </div>

      {/* курсы */}
      {patient.courses.length > 0 ? (
        <div className="border-border-soft mt-5 border-t pt-5">
          <SectionLabel>Курсы</SectionLabel>
          <div className="flex flex-col gap-3.5">
            {patient.courses.map((course) => {
              const pct = Math.round((course.used / course.total) * 100);
              const stalled = course.status === "stalled";
              // Курс, где все сеансы пройдены, «идёт» только на бумаге.
              const done = course.status === "done" || course.used >= course.total;
              return (
                <div key={course.id}>
                  <div className="flex items-baseline justify-between gap-3 max-md:flex-col max-md:items-start max-md:gap-1">
                    <span className="truncate text-sm font-medium">{course.title}</span>
                    <span className="num text-text-muted flex-none text-xs">
                      {course.used}/{course.total}
                    </span>
                  </div>
                  <div className="bg-list-gap mt-2 h-1.5 overflow-hidden rounded-pill">
                    <div className="bg-accent h-full rounded-pill" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-1.5 flex items-baseline justify-between gap-3">
                    <span
                      className={`text-2xs ${stalled ? "text-accent-text font-medium" : "text-text-subtle"}`}
                    >
                      {done ? "курс пройден" : stalled ? "выпал из графика" : "идёт по курсу"}
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
                  <span className="block truncate text-sm">
                    {/*
                      Время визита обязательно. Без него два сеанса одного дня —
                      а на курсе это обычное дело — выглядят одинаковыми
                      строками, и карточка читается как задвоенная.
                    */}
                    {visit.at && visit.kind !== "purchase" ? (
                      <span className="num text-text-subtle mr-1.5">{visitTime(visit.at)}</span>
                    ) : null}
                    {visit.service}
                  </span>
                  <span
                    className={`text-2xs ${
                      visit.kind === "purchase"
                        ? "text-accent-text font-medium"
                        : VISIT_STATUS[visit.status].cls
                    }`}
                  >
                    {visit.kind === "purchase"
                      ? "покупка курса"
                      : `${visit.doctor} · ${VISIT_STATUS[visit.status].label}`}
                  </span>
                </span>
                {/*
                  Деньги показываем у состоявшегося приёма и у покупки курса.
                  У запланированного визита стоит цена из записи, но денег ещё
                  не было, а у пациента на курсе она к тому же обнулится при
                  закрытии сеанса.

                  Нулей три, и они разные: подарок по скидке, сеанс
                  оплаченного курса и приём, за который клиника денег не брала.
                */}
                {visit.status !== "arrived" ? null : visit.amount > 0 ? (
                  /*
                    Курсовая услуга с суммой — сеанс, оплаченный отдельно (сверх
                    курса или разовый визит). Без подписи это читается как сбой
                    привязки: рядом стоят такие же приёмы с «курс 3/10».
                  */
                  <span className="flex flex-none items-baseline gap-1.5">
                    {visit.courseService && !visit.courseSession && visit.kind !== "purchase" ? (
                      <span
                        className="text-text-subtle text-2xs"
                        title="Курсовая услуга, но за этот приём взяли деньги в самой записи YCLIENTS: с курса сеанс не списан. Обычно это сеанс сверх курса или разовый визит."
                      >
                        отдельно
                      </span>
                    ) : null}
                    <span
                      className={`num text-xs ${
                        visit.kind === "purchase" ? "text-accent-text font-medium" : "text-text-muted"
                      }`}
                    >
                      {formatMoney(visit.amount)}
                    </span>
                  </span>
                ) : visit.courseSession ? (
                  <span className="text-text-muted flex-none text-xs">
                    курс {visit.courseSession.index}/{visit.courseSession.total}
                  </span>
                ) : visit.amountSource === "PREPAID" ? (
                  <span
                    className="text-text-muted flex-none text-xs"
                    title="оплачено раньше — при продаже курса; выручку даёт день продажи"
                  >
                    по курсу
                  </span>
                ) : (
                  <span className="text-text-muted flex-none text-xs">бесплатно</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* звонки */}
      {calls.length > 0 ? (
        <div className="border-border-soft mt-5 border-t pt-5">
          <SectionLabel>Звонки</SectionLabel>
          <ul className="flex flex-col gap-2">
            {calls.map((c) => (
              <li key={c.id} className="flex items-baseline gap-2">
                <span className="text-text-subtle w-14 flex-none text-2xs">
                  {c.direction === "in" ? "входящий" : "исходящий"}
                </span>
                <span className="flex-1 text-xs leading-snug">
                  {c.serviceInterest ? `${c.serviceInterest}. ` : ""}
                  {c.note || "—"}
                </span>
                <span className="num text-text-subtle flex-none text-2xs">{c.at}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

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
        {/*
          Дата, а не только «сегодня/ранее». Прежде здесь шли источник и это
          слово, и на экране получалось «Первое обращение: — · ранее»: даты не
          было вовсе, а прочерк — это неизвестный источник.
        */}
        Первое обращение: {firstContact} · источник: {patient.source ?? "из YCLIENTS"}
      </div>
    </div>
  );
}
