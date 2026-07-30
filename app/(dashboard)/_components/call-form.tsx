"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getDb, logCall } from "@/app/_data/store";
import { normalizePhone } from "@/lib/phone";
import { getCallOptions, type CallOptions } from "./call-actions";
import { recordCall } from "./call-record-action";

/**
 * Занести звонок — глобальная форма, открывается в один клик из любого экрана
 * (§3.4). Звонок — обращение наравне с сообщением: привязываем к пациенту по
 * номеру, не нашли — можно завести. Закрывается за считанные секунды.
 */
export function CallButton({ className = "" }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event("open-call"))}
      className={`border-border text-text-muted hover:bg-hover rounded-md border px-3 py-2 text-sm ${className}`}
    >
      Занести звонок
    </button>
  );
}

export function CallForm() {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);

  useEffect(() => {
    function onOpen() {
      setOpen(true);
      setCount((c) => c + 1);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("open-call", onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("open-call", onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!open) return null;
  return <CallInner key={count} onClose={() => setOpen(false)} />;
}

type Stage =
  | { kind: "form" }
  | { kind: "unmatched"; phone: string }
  | { kind: "done"; patientId: string | null };

function CallInner({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [options, setOptions] = useState<CallOptions>({ services: [], sources: [] });
  const services = options.services;
  const sources = options.sources;

  const [direction, setDirection] = useState<"in" | "out">("in");
  const [phone, setPhone] = useState("");
  const [service, setService] = useState("");
  const [source, setSource] = useState("");
  const [note, setNote] = useState("");
  const [name, setName] = useState("");
  const [stage, setStage] = useState<Stage>({ kind: "form" });

  // Услуги и источники — из БД (разделы «Услуги» и «Источники»).
  useEffect(() => {
    let alive = true;
    getCallOptions().then((opts) => {
      if (!alive) return;
      setOptions(opts);
      setSource((cur) => cur || opts.sources[0]?.title || "");
    });
    return () => {
      alive = false;
    };
  }, []);

  // service — id услуги; для стора нужен заголовок, для БД — id.
  const serviceTitle = services.find((s) => s.id === service)?.title ?? null;
  const base = {
    phone,
    direction,
    serviceInterest: serviceTitle,
    source: source || null,
    note,
  };
  const recordInput = {
    phone,
    direction,
    serviceId: service || null,
    sourceTitle: source || null,
    note,
  };

  function submit() {
    const e164 = normalizePhone(phone) ?? phone;
    const match = getDb().patients.find((p) => p.phones.some((ph) => ph.e164 === e164));
    if (match) {
      const { patientId } = logCall({ ...base, patientId: match.id });
      void recordCall(recordInput).catch(() => {});
      setStage({ kind: "done", patientId });
    } else {
      setStage({ kind: "unmatched", phone });
    }
  }

  const ready = phone.trim().length >= 5;

  return (
    <div className="overlay-scrim fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 py-[6vh] max-md:p-0" onMouseDown={onClose} role="presentation">
      <div
        className="bg-surface border-border flex max-h-[88vh] w-full max-w-[440px] flex-col rounded-2xl border max-md:h-full max-md:max-h-none max-md:rounded-none"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Занести звонок"
      >
        <div className="border-border flex items-center justify-between border-b px-5 py-4">
          <div className="text-md font-medium">Занести звонок</div>
          <button
            type="button"
            onClick={onClose}
            className="text-text-subtle hover:text-text rounded-sm px-1 text-lg leading-none"
            aria-label="Закрыть"
          >
            ×
          </button>
        </div>

        {stage.kind === "done" ? (
          <div className="flex-1 px-5 py-6">
            <p className="text-md font-medium">Звонок занесён</p>
            <p className="text-text-muted mt-2 text-sm">
              {stage.patientId
                ? "Обращение записано и привязано к пациенту."
                : "Обращение записано без привязки к пациенту."}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {stage.patientId ? (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    router.push(`/patients/${stage.patientId}`);
                  }}
                  className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-3.5 py-2 text-sm font-medium"
                >
                  Открыть карточку
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setStage({ kind: "form" })}
                className="border-border text-text-muted hover:bg-hover rounded-md border px-3.5 py-2 text-sm"
              >
                Занести ещё
              </button>
            </div>
          </div>
        ) : stage.kind === "unmatched" ? (
          <div className="flex-1 px-5 py-6">
            <p className="text-md font-medium">Номер не найден в базе</p>
            <p className="text-text-muted mt-2 text-sm">
              Можно завести пациента с этим номером или записать обращение без
              привязки.
            </p>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Имя пациента"
              className="border-border-input bg-surface mt-4 w-full rounded-md border px-3 py-2 text-sm outline-none"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={name.trim().length < 2}
                onClick={() => {
                  const { patientId } = logCall({ ...base, createNamed: name });
                  void recordCall({ ...recordInput, createNamed: name }).catch(() => {});
                  setStage({ kind: "done", patientId });
                }}
                className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-3.5 py-2 text-sm font-medium disabled:opacity-45"
              >
                Создать и привязать
              </button>
              <button
                type="button"
                onClick={() => {
                  const { patientId } = logCall(base);
                  void recordCall(recordInput).catch(() => {});
                  setStage({ kind: "done", patientId });
                }}
                className="border-border text-text-muted hover:bg-hover rounded-md border px-3.5 py-2 text-sm"
              >
                Без пациента
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-auto px-5 py-4">
              <div className="text-text-subtle mb-2 text-2xs">Направление</div>
              <div className="border-border inline-flex overflow-hidden rounded-md border">
                {(["in", "out"] as const).map((d, i) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDirection(d)}
                    className={`px-3 py-1.5 text-sm ${i > 0 ? "border-border border-l" : ""} ${
                      direction === d ? "bg-accent-tint text-accent-text font-medium" : "text-text-muted hover:bg-hover"
                    }`}
                  >
                    {d === "in" ? "Входящий" : "Исходящий"}
                  </button>
                ))}
              </div>

              <div className="text-text-subtle mt-5 mb-2 text-2xs">Телефон</div>
              <input
                autoFocus
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+7 900 000-00-00"
                className="border-border-input bg-surface num w-full rounded-md border px-3 py-2 text-sm outline-none"
              />

              <div className="text-text-subtle mt-5 mb-2 text-2xs">Интересует услуга</div>
              <select
                value={service}
                onChange={(e) => setService(e.target.value)}
                className="border-border-input bg-surface w-full rounded-md border px-3 py-2 text-sm outline-none"
              >
                <option value="">не указана</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>

              <div className="text-text-subtle mt-5 mb-2 text-2xs">Откуда узнали</div>
              <select
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className="border-border-input bg-surface w-full rounded-md border px-3 py-2 text-sm outline-none"
              >
                {sources.map((s) => (
                  <option key={s.title} value={s.title}>
                    {s.title}
                  </option>
                ))}
              </select>

              <div className="text-text-subtle mt-5 mb-2 text-2xs">Заметка</div>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Коротко, о чём звонок"
                className="border-border-input bg-surface w-full rounded-md border px-3 py-2 text-sm outline-none"
              />
            </div>

            <div className="border-border border-t px-5 py-4">
              <button
                type="button"
                disabled={!ready}
                onClick={submit}
                className="bg-accent text-accent-contrast hover:bg-accent-hover w-full rounded-md py-2.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-45"
              >
                Занести
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
