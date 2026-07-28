"use client";

import { useState } from "react";
import { settingsStore, type RoomSettings } from "@/app/_data/settings";
import { Field, Group, SaveBar, Segmented, SettingsHeader, TextInput, Toggle } from "../_components/ui";

export default function RoomsSettingsPage() {
  const [rooms, setRooms] = useState<RoomSettings[]>(() => structuredClone(settingsStore.rooms));

  const error = rooms.some((r) => r.name.trim().length === 0)
    ? "У кабинета не может быть пустого названия"
    : null;

  function patchRoom(id: string, next: Partial<RoomSettings>) {
    setRooms((rs) => rs.map((r) => (r.id === id ? { ...r, ...next } : r)));
  }

  return (
    <>
      <SettingsHeader
        title="Кабинеты"
        description="Три кабинета: название, направление, активность. Часы — свои или унаследованные от клиники. Источник кабинета для загрузки: ресурс YCLIENTS или привязка к специалисту."
      />
      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <div className="flex max-w-[720px] flex-col gap-4">
          {rooms.map((room) => (
            <Group key={room.id}>
              <Field label="Название" htmlFor={`${room.id}-name`}>
                <TextInput
                  id={`${room.id}-name`}
                  value={room.name}
                  onChange={(e) => patchRoom(room.id, { name: e.target.value })}
                />
              </Field>
              <Field label="Направление" htmlFor={`${room.id}-dir`}>
           <div>
            <option>
              <select id={`${room.id}-dir`} value={room.direction} onChange={(e) => patchRoom(room.id, { direction: e.target.value })}>
                   
               </select>
               
            </option>

              <TextInput
                  id={`${room.id}-dir`}
                  value={room.direction}
                  onChange={(e) => patchRoom(room.id, { direction: e.target.value })}
                />
              
           </div>
              </Field>
              <Field label="Активен">
                <Toggle
                  checked={room.isActive}
                  onChange={(v) => patchRoom(room.id, { isActive: v })}
                  label={`Кабинет ${room.name} активен`}
                />
              </Field>
              <Field label="Часы работы" hint="наследовать от клиники или задать свои">
                <Segmented
                  value={room.inheritsClinicSchedule ? "inherit" : "own"}
                  onChange={(v) => patchRoom(room.id, { inheritsClinicSchedule: v === "inherit" })}
                  options={[
                    { value: "inherit", label: "От клиники" },
                    { value: "own", label: "Своё" },
                  ]}
                />
              </Field>
              <Field label="Источник кабинета" hint="откуда берётся кабинет визита для загрузки">
                <Segmented
                  value={room.sourceMode}
                  onChange={(v) => patchRoom(room.id, { sourceMode: v })}
                  options={[
                    { value: "resource", label: "Ресурс YCLIENTS" },
                    { value: "staff", label: "Привязка к специалисту" },
                  ]}
                />
              </Field>
            </Group>
          ))}

          <SaveBar
            error={error}
            onSave={() => {
              settingsStore.rooms = structuredClone(rooms);
            }}
          />
        </div>
      </div>
    </>
  );
}
