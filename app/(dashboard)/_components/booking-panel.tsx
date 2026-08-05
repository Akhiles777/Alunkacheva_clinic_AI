"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { addAppt, getDb, useDb } from "@/app/_data/store";
import { formatMinute, freeGaps } from "@/lib/metrics/occupancy";
import { CLINIC_DAY, durationLabel, hasConflict, roomIntervals } from "@/lib/schedule";
import {
  getClinicDayToday,
  getServicesForBooking,
  getSpecialistsForBooking,
  searchPatientsForBooking,
  type ClinicDayView,
  type PatientOption,
  type ServiceOption,
  type SpecialistOption,
} from "../schedule/actions";
import { Picker, type PickerItem } from "./picker";

/**
 * Панель записи. Свободные окна считаются из ЕДИНОГО источника (стор
 * db.appointments) — те же данные, что на «Сегодня» и «Расписании». Перед
 * созданием слот перепроверяется на занятость (модель «перепроверки в YCLIENTS»,
 * §2): если за время выбора его заняли — запись не создаётся. Успешная запись
 * реально добавляется в стор и появляется в расписании.
 */
type Check = "idle" | "checking" | "created" | "taken";

/** Запасные названия кабинетов: используются, только если у услуги не указан кабинет. */
const ROOM_NAME: Record<string, string> = {
  "room-1": "Кабинет 1 · процедурный",
  "room-2": "Кабинет 2 · БОС",
  "room-3": "Кабинет 3 · остеопат",
};

function toPatientItem(p: PatientOption): PickerItem {
  const parts = [p.phone, p.visits > 0 ? `визитов ${p.visits}` : "новый"].filter(Boolean);
  return { id: p.id, title: p.name, subtitle: parts.join(" · ") };
}

function toStaffItem(s: SpecialistOption): PickerItem {
  return { id: s.id, title: s.name, subtitle: s.specialty };
}

interface WindowOption {
  id: string;
  roomId: string;
  startMinute: number;
  durationMin: number;
  cab: string;
  dir: string;
  dur: string;
}

export function BookingButton({ className = "" }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event("open-booking"))}
      className={`bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-4 py-2 text-sm font-medium ${className}`}
    >
      + Запись
    </button>
  );
}

export function BookingPanel() {
  const [open, setOpen] = useState(false);
  const [openCount, setOpenCount] = useState(0);

  useEffect(() => {
    function onOpen() {
      setOpen(true);
      setOpenCount((c) => c + 1);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("open-booking", onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("open-booking", onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!open) return null;
  return <BookingInner key={openCount} onClose={() => setOpen(false)} />;
}

function BookingInner({ onClose }: { onClose: () => void }) {
  const db = useDb();
  const [services, setServices] = useState<ServiceOption[]>([]);
  // Рабочее окно клиники на сегодня: в праздник и в укороченный день оно
  // другое, и свободные окна обязаны это учитывать.
  const [clinicDay, setClinicDay] = useState<ClinicDayView | null>(null);
  const [serviceKey, setServiceKey] = useState<string | null>(null);
  const [windowId, setWindowId] = useState<string | null>(null);
  const [patient, setPatient] = useState("");
  /**
   * Выбранный из базы пациент. Пока он не выбран, имя в поле — это заявка
   * завести нового: так администратор всегда видит, свяжется запись с
   * существующей карточкой или появится ещё одна.
   */
  const [patientPicked, setPatientPicked] = useState<PatientOption | null>(null);
  const [patientFound, setPatientFound] = useState<PatientOption[]>([]);
  const [patientLoading, setPatientLoading] = useState(false);

  const [specialists, setSpecialists] = useState<SpecialistOption[]>([]);
  const [staffPicked, setStaffPicked] = useState<SpecialistOption | null>(null);
  const [staffQuery, setStaffQuery] = useState("");
  const [check, setCheck] = useState<Check>("idle");
  const [booked, setBooked] = useState<{ time: string; room: string } | null>(null);
  const [price, setPrice] = useState<string>("");
  const [note, setNote] = useState("");
  const [bookedBy, setBookedBy] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    getServicesForBooking().then(setServices).catch(() => {});
    getClinicDayToday().then(setClinicDay).catch(() => {});
    getSpecialistsForBooking().then(setSpecialists).catch(() => {});
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  /**
   * Поиск пациента с задержкой: администратор печатает быстро, и запрос на
   * каждую букву только мешает. Пустая строка тоже ищет — показываем последних
   * заведённых, чтобы список не был пустым до первого символа.
   */
  useEffect(() => {
    if (patientPicked) return;
    setPatientLoading(true);
    const t = setTimeout(() => {
      searchPatientsForBooking(patient)
        .then(setPatientFound)
        .catch(() => setPatientFound([]))
        .finally(() => setPatientLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [patient, patientPicked]);

  const service = services.find((s) => s.id === serviceKey) ?? null;
  // Цена по умолчанию — из настроек услуги; администратор может изменить.
  const defaultPrice = service?.price ?? 0;

  // Реальные свободные окна выбранной услуги в её кабинете — из стора.
  const windows: WindowOption[] = useMemo(() => {
    if (!service) return [];
    if (!service.roomKey) return [];
    if (clinicDay?.closed) return [];
    const roomKey = service.roomKey;
    const day = clinicDay
      ? { startMinute: clinicDay.startMinute, endMinute: clinicDay.endMinute }
      : CLINIC_DAY;
    const gaps = freeGaps(roomIntervals(db.appointments, roomKey), day, service.durationMin);
    return gaps.map((g) => ({
      id: `${roomKey}-${g.startMinute}`,
      roomId: roomKey,
      startMinute: g.startMinute,
      durationMin: service.durationMin,
      cab: service.roomName ?? ROOM_NAME[roomKey],
      dir: service.title.split(",")[0],
      dur: durationLabel(g.durationMin),
    }));
  }, [service, db.appointments, clinicDay]);

  const selected = windows.find((w) => w.id === windowId) ?? null;

  /**
   * Специалисты, подходящие услуге: сначала закреплённые за её кабинетом.
   * Остальных не прячем — подменить коллегу на смене дело обычное, и форма
   * не должна этому мешать.
   */
  const staffOptions: SpecialistOption[] = useMemo(() => {
    const q = staffQuery.trim().toLowerCase();
    const matched = specialists.filter(
      (s) => !q || s.name.toLowerCase().includes(q) || (s.specialty ?? "").toLowerCase().includes(q),
    );
    if (!service) return matched;
    return [...matched].sort((a, b) => {
      const own = (s: SpecialistOption) => (s.roomKey === service.roomKey ? 0 : 1);
      return own(a) - own(b);
    });
  }, [specialists, staffQuery, service]);

  const ready = service && selected && staffPicked && (patientPicked || patient.trim().length > 1);

  function verifyAndBook() {
    if (!service || !selected || !staffPicked) return;
    setCheck("checking");
    if (timer.current) clearTimeout(timer.current);
    // Перепроверка занятости по свежему состоянию (модель запроса в YCLIENTS).
    timer.current = setTimeout(() => {
      const conflict = hasConflict(
        getDb().appointments,
        selected.roomId,
        selected.startMinute,
        selected.durationMin,
      );
      if (conflict) {
        setCheck("taken");
        return;
      }
      addAppt({
        roomId: selected.roomId,
        roomName: service.roomName ?? ROOM_NAME[selected.roomId],
        doctor: staffPicked.name,
        staffId: staffPicked.id,
        service: service.title,
        patientId: patientPicked?.id ?? null,
        patientName: (patientPicked?.name ?? patient).trim(),
        startMinute: selected.startMinute,
        durationMin: selected.durationMin,
        status: "planned",
        price: price.trim() === "" ? defaultPrice : Number(price),
        note: note.trim() || null,
        bookedByName: bookedBy.trim() || null,
      });
      setBooked({
        time: formatMinute(selected.startMinute),
        room: service.roomName ?? ROOM_NAME[selected.roomId],
      });
      setCheck("created");
    }, 700);
  }

  return (
    <div
      className="overlay-scrim fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 py-[6vh] max-md:p-0"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        className="bg-surface border-border flex max-h-[88vh] w-full max-w-[440px] flex-col rounded-2xl border max-md:h-full max-md:max-h-none max-md:rounded-none"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Новая запись"
      >
        <div className="border-border flex items-center justify-between border-b px-5 py-4">
          <div className="text-md font-medium">Новая запись</div>
          <button
            type="button"
            onClick={onClose}
            className="text-text-subtle hover:text-text rounded-sm px-1 text-lg leading-none"
            aria-label="Закрыть"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4">
          <div className="text-text-subtle mb-2 text-2xs">Услуга</div>
          <div className="flex flex-wrap gap-1.5">
            {services.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  setServiceKey(s.id);
                  setWindowId(null);
                  setCheck("idle");
                  setPrice(String(s.price || ""));
                  // Подставляем специалиста этого кабинета — обычный случай.
                  // Выбор остаётся за администратором: сменщиков меняют часто.
                  const own = specialists.filter((sp) => sp.roomKey === s.roomKey);
                  setStaffPicked(own.length === 1 ? own[0] : null);
                  setStaffQuery("");
                }}
                className={`rounded-md border px-2.5 py-1.5 text-sm ${
                  serviceKey === s.id
                    ? "border-accent-border bg-accent-tint text-accent-text font-medium"
                    : "border-border text-text-muted hover:bg-hover"
                }`}
              >
                {s.title}
                <span className="text-text-subtle ml-1.5 text-xs">{s.durationMin} мин</span>
              </button>
            ))}
          </div>

          <div className="text-text-subtle mt-5 mb-2 text-2xs">
            Свободное окно{service?.roomName ? ` · ${service.roomName}` : ""}
          </div>
          {clinicDay?.closed ? (
            <p className="text-text-subtle text-sm">
              Сегодня клиника не работает{clinicDay.label ? ` — ${clinicDay.label}` : ""}. Запись на
              этот день не оформляется; исключения задаются в настройках клиники.
            </p>
          ) : !service ? (
            <p className="text-text-subtle text-sm">Сначала выберите услугу.</p>
          ) : !service.roomKey ? (
            <p className="text-text-subtle text-sm">
              У услуги «{service.title}» не указан кабинет — задайте его в настройках услуг, иначе
              свободные окна считать не из чего.
            </p>
          ) : windows.length === 0 ? (
            <p className="text-text-subtle text-sm">
              В {service.roomName} нет свободного окна на {service.durationMin} мин до конца дня.
            </p>
          ) : (
            <ul className="border-border overflow-hidden rounded-lg border">
              {windows.map((w, i) => {
                const sel = windowId === w.id;
                return (
                  <li key={w.id} className={i > 0 ? "border-border-soft border-t" : undefined}>
                    <button
                      type="button"
                      onClick={() => {
                        setWindowId(w.id);
                        setCheck("idle");
                      }}
                      className={`flex w-full items-center gap-3 px-3 py-2.5 text-left ${
                        sel ? "bg-accent-tint" : "hover:bg-hover"
                      }`}
                    >
                      <span className={`num text-data font-medium ${sel ? "text-accent-text" : "text-text"}`}>
                        {formatMinute(w.startMinute)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{w.cab}</span>
                        <span className="text-text-subtle block truncate text-xs">
                          окно {w.dur}, приём {durationLabel(w.durationMin)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <Picker
            label="Пациент"
            placeholder="Начните вводить имя или телефон"
            loading={patientLoading}
            query={patient}
            items={patientFound.map(toPatientItem)}
            selected={patientPicked ? toPatientItem(patientPicked) : null}
            onQuery={(v) => {
              setPatient(v);
              setCheck("idle");
            }}
            onSelect={(item) => {
              const found = patientFound.find((p) => p.id === item.id) ?? null;
              setPatientPicked(found);
              setCheck("idle");
            }}
            onClear={() => {
              setPatientPicked(null);
              setPatient("");
            }}
            emptyHint="В базе никого не нашли"
            footer={
              patient.trim().length > 1 ? (
                <button
                  type="button"
                  onClick={() => setPatientPicked(null)}
                  className="hover:bg-hover w-full px-3 py-2 text-left text-sm"
                >
                  Записать как нового: <span className="font-medium">{patient.trim()}</span>
                </button>
              ) : null
            }
          />
          {!patientPicked && patient.trim().length > 1 ? (
            <p className="text-text-subtle mt-1.5 text-xs">
              Пациент не выбран из базы — будет заведена новая карточка.
            </p>
          ) : null}

          <Picker
            label="Специалист"
            placeholder="Начните вводить фамилию"
            query={staffQuery}
            items={staffOptions.map(toStaffItem)}
            selected={staffPicked ? toStaffItem(staffPicked) : null}
            onQuery={setStaffQuery}
            onSelect={(item) => {
              setStaffPicked(specialists.find((s) => s.id === item.id) ?? null);
              setCheck("idle");
            }}
            onClear={() => {
              setStaffPicked(null);
              setStaffQuery("");
            }}
            emptyHint="Такого специалиста нет"
          />

          <div className="text-text-subtle mt-5 mb-2 text-2xs">
            Цена{service ? ` · по умолчанию ${defaultPrice} ₽` : ""}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              step={100}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder={service ? String(defaultPrice) : "выберите услугу"}
              disabled={!service}
              className="border-border-input bg-surface num w-32 rounded-md border px-3 py-2 text-sm outline-none disabled:opacity-50"
            />
            <span className="text-text-subtle text-sm">₽</span>
          </div>

          <div className="text-text-subtle mt-5 mb-2 text-2xs">
            Записывает другой человек · родитель за ребёнка, супруг за супругу
          </div>
          <input
            value={bookedBy}
            onChange={(e) => setBookedBy(e.target.value)}
            placeholder="Необязательно. Имя и телефон того, кто записывает."
            className="border-border-input bg-surface placeholder:text-text-subtle w-full rounded-md border px-3 py-2 text-sm outline-none"
          />

          <div className="text-text-subtle mt-5 mb-2 text-2xs">Дополнительно · отзыв, проблема, примечание</div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Необязательно. Это учтёт ИИ-аналитик."
            className="border-border-input bg-surface placeholder:text-text-subtle w-full resize-y rounded-md border px-3 py-2 text-sm outline-none"
          />
        </div>

        <div className="border-border border-t px-5 py-4">
          {check === "taken" ? (
            <p className="text-accent-text mb-2.5 text-sm">
              Слот уже заняли, пока вы выбирали. Возьмите другое окно.
            </p>
          ) : check === "created" ? (
            <p className="text-text-muted mb-2.5 text-sm">
              Запись создана — {booked?.time}, {booked?.room}. Видна в расписании.
            </p>
          ) : (
            <p className="text-text-subtle mb-2.5 text-xs">Перед записью слот перепроверяется на занятость.</p>
          )}
          <button
            type="button"
            disabled={(!ready || check === "checking") && check !== "created"}
            onClick={check === "created" ? onClose : verifyAndBook}
            className="bg-accent text-accent-contrast hover:bg-accent-hover w-full rounded-md py-2.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-45"
          >
            {check === "checking"
              ? "Проверяем слот…"
              : check === "created"
                ? "Готово"
                : check === "taken"
                  ? "Выбрать другое окно"
                  : "Проверить и записать"}
          </button>
        </div>
      </div>
    </div>
  );
}
