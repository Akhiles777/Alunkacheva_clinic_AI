"use client";

import { useId, useState, useTransition } from "react";
import {
  Field,
  Group,
  Modal,
  Segmented,
  TextInput,
  Toggle,
} from "../_components/ui";
import {
  createRoom,
  deleteRoom,
  updateRoom,
  type RoomInput,
  type RoomRow,
  type RoomsPayload,
} from "./actions";

function toInput(r: RoomRow): RoomInput {
  return {
    name: r.name,
    direction: r.direction,
    isActive: r.isActive,
    inheritsClinicSchedule: r.inheritsClinicSchedule,
    staffIds: r.staffIds,
  };
}

function sameStaff(a: string[], b: string[]) {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}
function dirty(a: RoomRow, b: RoomRow) {
  return (
    a.name !== b.name ||
    a.direction !== b.direction ||
    a.isActive !== b.isActive ||
    a.inheritsClinicSchedule !== b.inheritsClinicSchedule ||
    !sameStaff(a.staffIds, b.staffIds)
  );
}

function StaffPicker({
  options,
  selected,
  onToggle,
}: {
  options: { id: string; name: string }[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  if (options.length === 0) {
    return (
      <p className="text-text-subtle text-sm">
        Сотрудники появятся здесь после добавления в разделе «Сотрудники».
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((s) => {
        const on = selected.includes(s.id);
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onToggle(s.id)}
            className={`rounded-md border px-2.5 py-1.5 text-sm ${
              on
                ? "border-accent-border bg-accent-tint text-accent-text font-medium"
                : "border-border text-text-muted hover:bg-hover"
            }`}
          >
            {s.name}
          </button>
        );
      })}
    </div>
  );
}

const BLANK: RoomRow = {
  id: "",
  name: "",
  direction: "",
  isActive: true,
  inheritsClinicSchedule: true,
  sortOrder: 0,
  staffIds: [],
};

export function RoomsClient({ initial }: { initial: RoomsPayload }) {
  const [payload, setPayload] = useState<RoomsPayload>(initial);
  const [draft, setDraft] = useState<RoomsPayload["rooms"]>(initial.rooms);
  const [open, setOpen] = useState(false);
  const [newRoom, setNewRoom] = useState<RoomRow>(BLANK);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const nameListId = useId();
  const dirListId = useId();

  const { staffOptions, nameSuggestions, directionSuggestions } = payload;

  function applyPayload(next: RoomsPayload) {
    setPayload(next);
    setDraft(next.rooms);
  }

  function patch(id: string, next: Partial<RoomRow>) {
    setDraft((rs) => rs.map((r) => (r.id === id ? { ...r, ...next } : r)));
    setError(null);
  }
  function toggleStaff(id: string, staffId: string) {
    setDraft((rs) =>
      rs.map((r) =>
        r.id === id
          ? {
              ...r,
              staffIds: r.staffIds.includes(staffId)
                ? r.staffIds.filter((s) => s !== staffId)
                : [...r.staffIds, staffId],
            }
          : r,
      ),
    );
  }

  function run(op: () => Promise<RoomsPayload>, id: string | null) {
    setError(null);
    setBusyId(id);
    startTransition(async () => {
      try {
        applyPayload(await op());
      } catch (e) {
        setError(e instanceof Error ? e.message : "Не удалось сохранить");
      } finally {
        setBusyId(null);
      }
    });
  }

  function saveRoom(row: RoomRow) {
    if (row.name.trim().length === 0) {
      setError("У кабинета не может быть пустого названия");
      return;
    }
    run(() => updateRoom(row.id, toInput(row)), row.id);
  }
  function removeRoom(id: string) {
    if (!confirm("Удалить кабинет? Это действие необратимо.")) return;
    run(() => deleteRoom(id), id);
  }
  function addRoom() {
    run(async () => {
      const res = await createRoom(toInput(newRoom));
      setNewRoom(BLANK);
      setOpen(false);
      return res;
    }, "new");
  }

  const serverById = new Map(payload.rooms.map((r) => [r.id, r]));

  return (
    <>
      <datalist id={nameListId}>
        {nameSuggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <datalist id={dirListId}>
        {directionSuggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>

      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <div className="flex max-w-[720px] flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <span className="num text-text-subtle text-xs">
              {draft.length} {draft.length === 1 ? "кабинет" : draft.length < 5 ? "кабинета" : "кабинетов"}
            </span>
            <button
              type="button"
              onClick={() => {
                setNewRoom(BLANK);
                setError(null);
                setOpen(true);
              }}
              className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-3.5 py-2 text-sm font-medium"
            >
              + Кабинет
            </button>
          </div>

          {error ? <p className="text-accent-text text-sm">{error}</p> : null}

          {draft.map((room) => {
            const server = serverById.get(room.id);
            const isDirty = server ? dirty(room, server) : true;
            const busy = busyId === room.id && isPending;
            return (
              <Group key={room.id}>
                <Field label="Название" hint="можно выбрать из списка или ввести своё">
                  <TextInput
                    list={nameListId}
                    value={room.name}
                    onChange={(e) => patch(room.id, { name: e.target.value })}
                  />
                </Field>
                <Field label="Направление" hint="можно выбрать из списка или ввести своё">
                  <TextInput
                    list={dirListId}
                    value={room.direction}
                    onChange={(e) => patch(room.id, { direction: e.target.value })}
                    placeholder="Например, IV-терапия"
                  />
                </Field>
                <Field label="Активен">
                  <Toggle
                    checked={room.isActive}
                    onChange={(v) => patch(room.id, { isActive: v })}
                    label={`Кабинет ${room.name} активен`}
                  />
                </Field>
                <Field label="Часы работы" hint="наследовать от клиники или задать свои">
                  <Segmented
                    value={room.inheritsClinicSchedule ? "inherit" : "own"}
                    onChange={(v) => patch(room.id, { inheritsClinicSchedule: v === "inherit" })}
                    options={[
                      { value: "inherit", label: "От клиники" },
                      { value: "own", label: "Своё" },
                    ]}
                  />
                </Field>
                <Field label="Специалисты" hint="кто по умолчанию принимает здесь — необязательно">
                  <StaffPicker
                    options={staffOptions}
                    selected={room.staffIds}
                    onToggle={(sid) => toggleStaff(room.id, sid)}
                  />
                </Field>
                <div className="border-border-soft flex items-center justify-between border-t pt-3">
                  <button
                    type="button"
                    onClick={() => removeRoom(room.id)}
                    disabled={busy}
                    className="text-text-subtle hover:text-text text-sm disabled:opacity-40"
                  >
                    Удалить кабинет
                  </button>
                  <div className="flex items-center gap-3">
                    {isDirty ? (
                      <span className="text-text-subtle text-xs">есть несохранённые изменения</span>
                    ) : (
                      <span className="text-text-subtle text-xs">сохранено</span>
                    )}
                    <button
                      type="button"
                      onClick={() => saveRoom(room)}
                      disabled={!isDirty || busy}
                      className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-40"
                    >
                      {busy ? "Сохраняем…" : "Сохранить"}
                    </button>
                  </div>
                </div>
              </Group>
            );
          })}

          {draft.length === 0 ? (
            <p className="text-text-muted text-sm">Кабинетов пока нет. Добавьте первый.</p>
          ) : null}
        </div>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Новый кабинет"
        description="Название и направление можно выбрать из подсказок или ввести свои. Привязка специалистов необязательна."
        footer={
          <>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="border-border text-text-muted hover:bg-hover rounded-md border px-3.5 py-2 text-sm"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={addRoom}
              disabled={newRoom.name.trim().length === 0 || (busyId === "new" && isPending)}
              className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-3.5 py-2 text-sm font-medium disabled:opacity-45"
            >
              {busyId === "new" && isPending ? "Добавляем…" : "Добавить"}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Название">
            <TextInput
              list={nameListId}
              value={newRoom.name}
              onChange={(e) => setNewRoom({ ...newRoom, name: e.target.value })}
              placeholder="Например, Кабинет 4 — массаж"
            />
          </Field>
          <Field label="Направление">
            <TextInput
              list={dirListId}
              value={newRoom.direction}
              onChange={(e) => setNewRoom({ ...newRoom, direction: e.target.value })}
              placeholder="Например, Массаж"
            />
          </Field>
          <Field label="Активен">
            <Toggle
              checked={newRoom.isActive}
              onChange={(v) => setNewRoom({ ...newRoom, isActive: v })}
              label="Новый кабинет активен"
            />
          </Field>
          <Field label="Часы работы">
            <Segmented
              value={newRoom.inheritsClinicSchedule ? "inherit" : "own"}
              onChange={(v) => setNewRoom({ ...newRoom, inheritsClinicSchedule: v === "inherit" })}
              options={[
                { value: "inherit", label: "От клиники" },
                { value: "own", label: "Своё" },
              ]}
            />
          </Field>
          <Field label="Специалисты" hint="необязательно">
            <StaffPicker
              options={staffOptions}
              selected={newRoom.staffIds}
              onToggle={(sid) =>
                setNewRoom((r) => ({
                  ...r,
                  staffIds: r.staffIds.includes(sid)
                    ? r.staffIds.filter((s) => s !== sid)
                    : [...r.staffIds, sid],
                }))
              }
            />
          </Field>
        </div>
      </Modal>
    </>
  );
}
