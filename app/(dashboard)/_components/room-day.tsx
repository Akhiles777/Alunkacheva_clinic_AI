import { formatDuration, formatPercent } from "@/lib/format";
import { formatMinute } from "@/lib/metrics/occupancy";
import type { RoomDay, RoomInterval } from "@/lib/metrics/types";

/**
 * Signature экрана — гравированная шкала канала (DESIGN.md §5).
 *
 * Три кабинета выровнены по одной шкале времени, как каналы прибора:
 * сравнение — движение глаза вдоль общей линейки. Приёмы утоплены во
 * вставках, свободное окно от часа — открытый паз с засечкой. Это
 * единственное место экрана, где виден сигнальный цвет.
 */

/**
 * Три ступени подписи сегмента: до 25 минут — только засечка, до 45 — метка
 * процедуры, дальше — метка и врач. Иначе «БОС · 40» и фамилия обрезаются на
 * середине слова, а обрезанное слово читается хуже, чем его отсутствие.
 */
const LABEL_MIN_MINUTES = 25;
const STAFF_MIN_MINUTES = 55;

/** Компактная длительность для мобильной ширины: «2:30». */
function compactDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours === 0 ? `${rest}м` : `${hours}:${String(rest).padStart(2, "0")}`;
}

/**
 * Короткие метки процедур. Полное название («IV-терапия, капельница
 * расширенная») в сегмент шириной 8% дня не влезает и обрезается на середине
 * слова — на шкале прибора нужна метка канала, а не заголовок.
 */
const KIND_LABEL: Record<RoomInterval["serviceKind"], string> = {
  OSTEOPATHY: "Остео",
  IV_THERAPY: "IV",
  BIOFEEDBACK: "БОС",
  NEUROMEDITATION: "Нейро",
  LAB: "Лаб",
  OTHER: "Приём",
};

/** Для сегментов 25–45 минут: даже короткая метка обрезается многоточием. */
const KIND_LABEL_SHORT: Record<RoomInterval["serviceKind"], string> = {
  OSTEOPATHY: "Ост",
  IV_THERAPY: "IV",
  BIOFEEDBACK: "БОС",
  NEUROMEDITATION: "НМ",
  LAB: "Лаб",
  OTHER: "—",
};

function position(minute: number, open: number, close: number): number {
  return ((minute - open) / (close - open)) * 100;
}

function span(from: number, to: number, open: number, close: number): number {
  return ((to - from) / (close - open)) * 100;
}

function ticks(open: number, close: number, step: number): number[] {
  const list: number[] = [];
  for (let minute = Math.ceil(open / step) * step; minute <= close; minute += step) {
    list.push(minute);
  }
  return list;
}

/** «Кабинет 2 · IV-терапия» → две строки: номер и направление. */
function splitRoomName(name: string): [string, string | null] {
  const parts = name.split(" · ");
  return [parts[0], parts.slice(1).join(" · ") || null];
}

/** Общая шкала времени: крупные деления на часах, мелкие на 15 минутах. */
function TimeScale({ open, close }: { open: number; close: number }) {
  const hours = ticks(open, close, 60);

  return (
    <div className="relative h-5">
      <span aria-hidden className="bg-groove absolute inset-x-0 bottom-0 h-px" />
      {ticks(open, close, 15).map((minute) => {
        const isHour = minute % 60 === 0;
        return (
          <span
            key={minute}
            aria-hidden
            className={`bg-groove absolute bottom-0 w-px ${isHour ? "h-2" : "h-1 opacity-55"}`}
            style={{ left: `${position(minute, open, close)}%` }}
          />
        );
      })}
      {hours.map((minute, index) => (
        <span
          key={minute}
          className={`num text-label absolute bottom-2 text-[10px] leading-none ${
            index === 0
              ? ""
              : index === hours.length - 1
                ? "-translate-x-full"
                : "-translate-x-1/2"
          } ${index % 2 === 1 ? "hidden md:inline" : ""}`}
          style={{ left: `${position(minute, open, close)}%` }}
        >
          {formatMinute(minute).slice(0, 2)}
        </span>
      ))}
    </div>
  );
}

function Channel({ room }: { room: RoomDay }) {
  const { openMinute: open, closeMinute: close } = room;
  const isEmpty = room.intervals.length === 0;
  const [roomNumber, roomKind] = splitRoomName(room.roomName);

  return (
    <li className="border-groove grid grid-cols-[76px_minmax(0,1fr)_46px] items-center gap-x-2 border-t py-2.5 md:grid-cols-[176px_minmax(0,1fr)_96px] md:gap-x-4 md:py-3">
      <div className="min-w-0">
        <p className="display truncate text-[12px] leading-tight font-semibold md:text-[15px]">
          {roomNumber}
        </p>
        {roomKind ? (
          <p className="text-label truncate text-[10px] leading-tight md:text-[11px]">{roomKind}</p>
        ) : null}
        <p className="num text-label mt-0.5 hidden text-[11px] leading-tight md:block">
          {formatDuration(room.busyMinutes)} из {formatDuration(room.workingMinutes)}
        </p>
      </div>

      <div
        role="group"
        aria-label={`${room.roomName}: занято ${formatDuration(room.busyMinutes)} из ${formatDuration(
          room.workingMinutes,
        )}, свободных окон ${room.gaps.length}`}
        className="border-groove bg-panel-sunk relative h-12 border md:h-[60px]"
      >
        {/* Часовая гравировка на дне паза. */}
        {ticks(open, close, 60)
          .slice(1, -1)
          .map((minute) => (
            <span
              key={minute}
              aria-hidden
              className="bg-groove absolute inset-y-0 w-px opacity-40"
              style={{ left: `${position(minute, open, close)}%` }}
            />
          ))}

        {/* Пустой канал не заливаем сигналом на всю ширину: это не «тревога
            на весь день», а просто открытый паз с одной подписью. */}
        {isEmpty ? (
          <p className="text-signal-ink absolute inset-0 flex items-center justify-center text-[12px] font-medium">
            канал свободен
          </p>
        ) : (
          room.gaps.map((gap) => (
            <div
              key={`gap-${gap.startMinute}`}
              className="groove-open absolute inset-y-0 overflow-hidden"
              style={{
                left: `${position(gap.startMinute, open, close)}%`,
                width: `${span(gap.startMinute, gap.endMinute, open, close)}%`,
              }}
            >
              {/* Засечка: форма дублирует цвет. */}
              <span aria-hidden className="bg-signal absolute inset-x-0 top-0 h-0.5" />
              {/* На мобильной ширине окно в 60 минут — это 18 px: подпись
                  туда не влезает, длительности перечислены строкой под
                  каналом. */}
              <span className="num text-signal-ink absolute inset-0 hidden items-center justify-center px-0.5 text-center text-[11px] leading-tight font-medium md:flex">
                {formatDuration(gap.durationMin)}
              </span>
            </div>
          ))
        )}

        {room.intervals.map((interval) => {
          const minutes = interval.endMinute - interval.startMinute;
          const isNarrow = minutes < LABEL_MIN_MINUTES;

          return (
            <div
              key={interval.appointmentId}
              title={`${formatMinute(interval.startMinute)}–${formatMinute(interval.endMinute)} · ${interval.serviceTitle} · ${interval.staffName} · ${interval.patientLabel}`}
              className="bg-inset border-groove absolute inset-y-0 overflow-hidden border-x px-1 py-1 md:px-1.5"
              style={{
                left: `${position(interval.startMinute, open, close)}%`,
                width: `${span(interval.startMinute, interval.endMinute, open, close)}%`,
              }}
            >
              {isNarrow ? (
                // Забор анализов — 10–15 минут, это ~2% ширины дня: подпись
                // туда не влезает, поэтому короткий приём — засечка, детали
                // в тултипе.
                <span
                  aria-hidden
                  className="bg-label absolute inset-x-[3px] top-1/2 h-px opacity-70"
                />
              ) : (
                <>
                  <p className="num text-engrave hidden truncate text-[11px] leading-3.5 font-medium md:block">
                    {minutes >= STAFF_MIN_MINUTES
                      ? `${KIND_LABEL[interval.serviceKind]} · ${minutes}`
                      : KIND_LABEL_SHORT[interval.serviceKind]}
                  </p>
                  {minutes >= STAFF_MIN_MINUTES ? (
                    <p className="text-label hidden truncate text-[10px] leading-3.25 md:block">
                      {interval.staffName}
                    </p>
                  ) : null}
                  <p className="num text-label absolute bottom-1 left-1.5 hidden text-[10px] leading-none md:block">
                    {formatMinute(interval.startMinute)}
                  </p>
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="text-right">
        <p className="num text-[14px] leading-none md:text-[22px]">
          {formatPercent(room.occupancy)}
        </p>
        <p className="legend mt-1 hidden md:block">
          за период {formatPercent(room.periodOccupancy)}
        </p>
      </div>

      {/* Мобильная сводка окон: на 375 px подпись внутрь паза не влезает,
          а именно окна — то, ради чего смотрят на полосу. */}
      {room.gaps.length > 0 ? (
        <p className="num text-signal-ink col-span-3 mt-1.5 text-[11px] leading-tight md:hidden">
          окна {room.gaps.map((gap) => compactDuration(gap.durationMin)).join(" · ")}
        </p>
      ) : null}
    </li>
  );
}

export function RoomDayBoard({ rooms }: { rooms: RoomDay[] }) {
  const [first] = rooms;
  if (!first) return null;

  return (
    <div>
      <div className="grid grid-cols-[76px_minmax(0,1fr)_46px] gap-x-2 md:grid-cols-[176px_minmax(0,1fr)_96px] md:gap-x-4">
        <span className="legend self-end pb-1">канал</span>
        <TimeScale open={first.openMinute} close={first.closeMinute} />
        <span className="legend self-end pb-1 text-right">занято</span>
      </div>

      <ul>
        {rooms.map((room) => (
          <Channel key={room.roomId} room={room} />
        ))}
      </ul>
    </div>
  );
}
