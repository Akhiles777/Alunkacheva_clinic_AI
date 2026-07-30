"use client";

import { useState } from "react";
import { Modal } from "../_components/modal";
import { addPatient } from "@/app/_data/store";
import { normalizePhone } from "@/lib/phone";

const SOURCES = ["Instagram", "WhatsApp", "Звонок", "Сайт", "Пришёл сам", "Рекомендация", "Вручную"];

/**
 * Добавление пациента нормальным модальным окном (вместо инлайн-формы в шапке).
 * Телефон проверяется на распознаваемость до сохранения.
 */
export function AddPatientModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [source, setSource] = useState("Вручную");
  const [phoneErr, setPhoneErr] = useState(false);

  function reset() {
    setName("");
    setPhone("");
    setSource("Вручную");
    setPhoneErr(false);
  }
  function submit() {
    if (name.trim().length < 2) return;
    if (phone.trim() && !normalizePhone(phone)) {
      setPhoneErr(true);
      return;
    }
    const created = addPatient({ name, phone, source });
    reset();
    onClose();
    onCreated(created.id);
  }

  const nameError = name.trim().length > 0 && name.trim().length < 2;

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Новый пациент"
      description="Имя обязательно, телефон — по желанию (нормализуется в E.164)."
      footer={
        <>
          <button
            type="button"
            onClick={() => {
              reset();
              onClose();
            }}
            className="border-border text-text-muted hover:bg-hover rounded-md border px-3.5 py-2 text-sm"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={name.trim().length < 2}
            className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-3.5 py-2 text-sm font-medium disabled:opacity-45"
          >
            Создать
          </button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-text-subtle text-2xs">Имя</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Фамилия Имя Отчество"
            className={`border-border-input bg-surface w-full rounded-md border px-3 py-2 text-sm outline-none ${nameError ? "border-accent-text" : ""}`}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-text-subtle text-2xs">Телефон</span>
          <input
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              setPhoneErr(false);
            }}
            placeholder="+7 900 000-00-00"
            className={`border-border-input bg-surface num w-full rounded-md border px-3 py-2 text-sm outline-none ${phoneErr ? "border-accent-text" : ""}`}
          />
          {phoneErr ? <span className="text-accent-text text-2xs">Не распознали номер — проверьте формат</span> : null}
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-text-subtle text-2xs">Источник</span>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="border-border-input bg-surface w-full rounded-md border px-3 py-2 text-sm outline-none"
          >
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </form>
    </Modal>
  );
}
