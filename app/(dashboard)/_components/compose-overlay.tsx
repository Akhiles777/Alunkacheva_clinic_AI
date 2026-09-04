"use client";

import { useState } from "react";
import {
  findPatient,
  searchPatients,
  startDialog,
  useDb,
} from "@/app/_data/store";

/** Каналы, в которых администратор может написать первым. */
type OutboundChannel = "instagram" | "whatsapp";

// Начать диалог администратор может в Instagram или WhatsApp. Telegram сюда
// не входит: там первым пишет пациент — бот не может постучаться сам.
const CHANNEL_LABEL: Record<OutboundChannel, string> = {
  instagram: "Instagram",
  whatsapp: "WhatsApp",
};

/**
 * Начать диалог — общий оверлей для Инбокса и Курсов. Можно открыть с
 * предзаполненным пациентом и текстом («Написать» из списка курсов), не уходя
 * со страницы.
 */
export function ComposeOverlay({
  onClose,
  onSent,
  prefillPatientId = null,
  prefillMessage = "",
  prefillChannel = "whatsapp",
}: {
  onClose: () => void;
  onSent?: (dialogId: string) => void;
  prefillPatientId?: string | null;
  prefillMessage?: string;
  prefillChannel?: OutboundChannel;
}) {
  const db = useDb();
  const [channel, setChannel] = useState<OutboundChannel>(prefillChannel);
  const [pquery, setPquery] = useState("");
  const [patientId, setPatientId] = useState<string | null>(prefillPatientId);
  const [message, setMessage] = useState(prefillMessage);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = pquery.trim() ? searchPatients(pquery, db.patients).slice(0, 4) : [];
  const chosen = patientId ? findPatient(patientId) : null;

  async function send() {
    if (!chosen || message.trim().length === 0 || sending) return;
    setSending(true);
    setError(null);
    const res = await startDialog({
      channel,
      name: chosen.name,
      patientId: chosen.id,
      message,
    });
    setSending(false);
    /**
     * «Отправлено» показываем только по факту отправки. Раньше эта надпись
     * появлялась всегда: сообщение оседало в базе, пациент его не видел, а
     * администратор был уверен, что написал.
     */
    if (!res.ok || !res.dialogId) {
      setError(res.error ?? "Сообщение не отправлено");
      return;
    }
    setSentTo(chosen.name);
    onSent?.(res.dialogId);
  }

  return (
    <div className="overlay-scrim fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 py-[6vh] max-md:p-0" onMouseDown={onClose} role="presentation">
      <div
        className="bg-surface border-border flex max-h-[88vh] w-full max-w-[440px] flex-col rounded-2xl border max-md:h-full max-md:max-h-none max-md:rounded-none"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Начать диалог"
      >
        <div className="border-border flex items-center justify-between border-b px-5 py-4">
          <div className="text-md font-medium">Начать диалог</div>
          <button type="button" onClick={onClose} className="text-text-subtle hover:text-text px-1 text-lg leading-none">
            ×
          </button>
        </div>

        {sentTo ? (
          <div className="flex-1 px-5 py-6">
            <p className="text-md font-medium">Сообщение отправлено</p>
            <p className="text-text-muted mt-2 text-sm">Диалог с «{sentTo}» открыт в «Диалогах».</p>
            <button
              type="button"
              onClick={onClose}
              className="border-border text-text-muted hover:bg-hover mt-4 rounded-md border px-3.5 py-2 text-sm"
            >
              Готово
            </button>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-auto px-5 py-4">
              <div className="text-text-subtle mb-2 text-2xs">Канал</div>
              <div className="border-border inline-flex overflow-hidden rounded-md border">
                {(["whatsapp", "instagram"] as const).map((c, i) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setChannel(c)}
                    className={`px-3 py-1.5 text-sm ${i > 0 ? "border-border border-l" : ""} ${
                      channel === c ? "bg-accent-tint text-accent-text font-medium" : "text-text-muted hover:bg-hover"
                    }`}
                  >
                    {CHANNEL_LABEL[c]}
                  </button>
                ))}
              </div>

              <div className="text-text-subtle mt-5 mb-2 text-2xs">Пациент</div>
              {chosen ? (
                <div className="border-border flex items-center gap-2 rounded-md border px-3 py-2">
                  <span className="flex-1 truncate text-sm">{chosen.name}</span>
                  <button type="button" onClick={() => setPatientId(null)} className="text-text-subtle hover:text-text text-sm">
                    ×
                  </button>
                </div>
              ) : (
                <>
                  <input
                    value={pquery}
                    onChange={(e) => setPquery(e.target.value)}
                    placeholder="Имя или телефон"
                    className="border-border-input bg-surface w-full rounded-md border px-3 py-2 text-sm outline-none"
                  />
                  {matches.length > 0 ? (
                    <ul className="border-border mt-1 overflow-hidden rounded-md border">
                      {matches.map((p) => (
                        <li key={p.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setPatientId(p.id);
                              setPquery("");
                            }}
                            className="hover:bg-hover w-full px-3 py-2 text-left text-sm"
                          >
                            {p.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              )}

              <div className="text-text-subtle mt-5 mb-2 text-2xs">Сообщение</div>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
                placeholder="Текст первого сообщения"
                className="border-border-input bg-surface w-full resize-y rounded-md border px-3 py-2 text-sm outline-none"
              />
            </div>
            <div className="border-border border-t px-5 py-4">
              {/*
                Причина отказа — словами и на месте. «WhatsApp: номер не
                зарегистрирован» и «в Instagram первым пишет пациент» требуют
                разных действий, и молчать о разнице нельзя.
              */}
              {error ? <p className="text-accent-text mb-2 text-sm">{error}</p> : null}
              <button
                type="button"
                disabled={!chosen || message.trim().length === 0 || sending}
                onClick={() => void send()}
                className="bg-accent text-accent-contrast hover:bg-accent-hover w-full rounded-md py-2.5 text-sm font-medium disabled:opacity-45"
              >
                {sending ? "Отправляем…" : "Отправить"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
