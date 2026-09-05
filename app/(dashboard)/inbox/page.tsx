"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { HANDBACK_HOURS } from "@/lib/agent/handback-rule";
import {
  CHANNEL_LABEL,
  DIALOG_FILTERS,
  DIALOG_STATUS_LABEL,
  dialogMatchesFilter,
} from "@/app/_data/inbox";
import {
  activeNotes,
  findPatient,
  hydrateDialogs,
  markDialogRead,
  returnToBot,
  setAgentEnabled,
  sendMessage,
  useDb,
  type Dialog,
} from "@/app/_data/store";
import {
  callAdminsDb,
  getConversations,
  getInboxTemplates,
  type ApprovedTemplate,
  type DialogAttachmentRecord,
} from "./actions";
import { ComposeOverlay } from "../_components/compose-overlay";
import { ContactPanel } from "./contact-panel";
import { PatientCardBody } from "../_components/patient-card";

/**
 * Вложение пациента в переписке.
 *
 * Голосовое и видео показываем проигрывателем прямо в диалоге: администратор
 * не должен скачивать файл, чтобы понять, о чём речь, — он отвечает быстро и
 * много. Фотографию направления показываем сразу по той же причине.
 *
 * Файлы идут через /api/media: прямая ссылка провайдера открыта любому, кто
 * её увидел, а голосовое пациента — сведения о факте обращения за помощью.
 */
function Attachment({ a }: { a: DialogAttachmentRecord }) {
  // Файла нет — геопозиция или контакт. Осталась подпись, и это правильно:
  // пустое место выглядело бы как несработавшая загрузка.
  if (!a.href) {
    return <div className="text-text-muted text-2xs">{a.label}</div>;
  }

  if (a.kind === "voice" || a.kind === "audio") {
    return (
      <div>
        <audio controls preload="metadata" src={a.href} className="w-full max-w-[260px]" />
        <div className="flex items-baseline gap-2">
          {a.durationSec ? (
            <span className="text-text-subtle num text-2xs">{formatDuration(a.durationSec)}</span>
          ) : null}
          {/*
            Запасной путь на случай, когда браузер не умеет этот звук.
            WhatsApp шлёт голосовые в Ogg Opus; Safari его не проигрывает, и
            проигрыватель там останется немым при целом файле. Ссылка даёт
            сотруднику услышать пациента, а не гадать.
          */}
          <a
            href={a.href}
            target="_blank"
            rel="noreferrer"
            className="text-text-subtle hover:text-accent-text text-2xs underline decoration-dotted"
          >
            не играет — открыть файл
          </a>
        </div>
      </div>
    );
  }

  if (a.kind === "photo") {
    return (
      <a href={a.href} target="_blank" rel="noreferrer">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={a.href}
          alt={a.label}
          loading="lazy"
          className="border-border max-h-56 rounded-lg border object-cover"
        />
      </a>
    );
  }

  if (a.kind === "video") {
    return <video controls preload="none" src={a.href} className="max-h-56 w-full rounded-lg" />;
  }

  return (
    <a
      href={a.href}
      target="_blank"
      rel="noreferrer"
      className="text-accent-text hover:underline text-2xs"
    >
      {a.fileName || a.label}
    </a>
  );
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const NOTE_SHORT: Record<string, string> = {
  NO_CONSENT: "нет согласия",
  INCOMPLETE_PASSPORT: "нет паспорта",
  ATTENTION: "внимание",
  CUSTOM: "заметка",
};

function DialogRow({
  dialog,
  active,
  onClick,
}: {
  dialog: Dialog;
  active: boolean;
  onClick: () => void;
}) {
  const patient = dialog.patientId ? findPatient(dialog.patientId) : undefined;
  const notes = patient ? activeNotes(patient) : [];

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full border-b border-border-soft px-4 py-3 text-left last:border-b-0 ${
        active ? "bg-nav-active" : "hover:bg-hover"
      }`}
    >
      <div className="flex items-baseline gap-2">
        {dialog.unread ? (
          <span aria-hidden className="bg-accent h-1.5 w-1.5 flex-none rounded-full" />
        ) : null}
        <span className="truncate text-sm font-medium">{dialog.name}</span>
        <span className="num text-text-subtle ml-auto flex-none text-2xs">{dialog.at}</span>
      </div>
      {/* Служебные отметки пациента видны сразу у имени (§5.3). */}
      {notes.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {notes.slice(0, 2).map((n) => (
            <span key={n.id} className="text-accent-text bg-accent-tint rounded-sm px-1.5 py-px text-2xs font-medium">
              {NOTE_SHORT[n.kind]}
            </span>
          ))}
        </div>
      ) : null}
      <p className="text-text-muted mt-1 truncate text-xs">{dialog.preview}</p>
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="text-text-subtle text-2xs">{CHANNEL_LABEL[dialog.channel]}</span>
        {dialog.status === "escalated" ? (
          <span className="text-accent-text text-2xs font-medium">· нужен человек</span>
        ) : dialog.agentDraft ? (
          <span className="text-accent-text text-2xs font-medium">· черновик готов</span>
        ) : (
          <span className="text-text-subtle text-2xs">· {DIALOG_STATUS_LABEL[dialog.status]}</span>
        )}
      </div>
    </button>
  );
}

function WindowBadge({ dialog }: { dialog: Dialog }) {
  if (!dialog.windowOpen) {
    return (
      <span className="border-accent-border bg-accent-tint text-accent-text flex-none rounded-sm border px-2 py-1 text-2xs font-medium">
        окно закрыто · только шаблон
      </span>
    );
  }
  if (dialog.windowMinutesLeft !== null) {
    const h = Math.floor(dialog.windowMinutesLeft / 60);
    const m = dialog.windowMinutesLeft % 60;
    const label = h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
    return (
      <span className="text-text-muted flex-none text-2xs">
        окно ответа: <span className="num">{label}</span>
      </span>
    );
  }
  return null;
}

function Thread({ dialog, onBack, refresh }: { dialog: Dialog; onBack: () => void; refresh: () => void }) {
  const [text, setText] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  /**
   * Результат вызова администраторов. Показываем словами: push уходит на
   * чужие телефоны, и нажавший иначе не узнает, ушёл он или нет.
   */
  const [ping, setPing] = useState<{ dialogId: string; text: string } | null>(null);
  const [pinging, setPinging] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const [approvedTemplates, setApprovedTemplates] = useState<ApprovedTemplate[]>([]);
  const [quickReplies, setQuickReplies] = useState<string[]>([]);

  /**
   * Открыли переписку — сразу к последнему сообщению. Читают всегда конец, а
   * не начало: без этого администратор пролистывал всю историю вручную.
   * Мгновенно при смене диалога и плавно при новом сообщении.
   */
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [dialog.id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [dialog.messages.length]);

  useEffect(() => {
    let alive = true;
    // Шаблоны и быстрые ответы приходят из раздела «Шаблоны»: раньше быстрые
    // ответы были зашиты в этом файле и настройки на них не влияли.
    getInboxTemplates().then((t) => {
      if (!alive) return;
      setApprovedTemplates(t.approved);
      setQuickReplies(t.quickReplies);
    });
    return () => {
      alive = false;
    };
  }, []);

  function submit() {
    if (dialog.windowOpen && text.trim()) {
      // Показываем результат доставки: молчаливый «успех» при неотправленном
      // сообщении — худший исход, администратор будет ждать ответа зря.
      void sendMessage(dialog.id, text).then((res) => {
        setSendError(res.ok ? null : (res.error ?? "Сообщение не отправлено"));
      });
      setText("");
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/*
        Шапка в две строки: имя и действия не спорят за место.

        Кнопок стало три, и в одну строку они выдавливали то, ради чего сюда
        смотрят в первую очередь, — имя собеседника. Имя, канал, статус и номер
        занимают верхнюю строку целиком; действия переносятся под ними и
        сворачиваются на узком экране сами. Порядок тот же, что важность:
        сначала «кто это», потом «что с ним делать».
      */}
      <div className="border-border flex flex-none flex-col gap-2 border-b px-5 py-3 max-md:px-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="text-text-muted hover:text-text flex-none text-sm md:hidden"
          >
            ← Диалоги
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">
              {dialog.patientId ? (
                <Link href={`/patients/${dialog.patientId}`} className="hover:underline">
                  {dialog.name}
                </Link>
              ) : (
                dialog.name
              )}
            </div>
            <div className="text-text-subtle truncate text-2xs">
              {CHANNEL_LABEL[dialog.channel]} · {DIALOG_STATUS_LABEL[dialog.status]}
              {/*
                Номер здесь не дублируем: строкой ниже он стоит ссылкой tel:,
                по которой можно позвонить. Два одинаковых номера подряд
                занимают место и ничего не добавляют.
              */}
              {/*
                Причина эскалации — здесь, а не среди кнопок: это сведение о
                диалоге, а не действие. И видно её теперь на телефоне тоже —
                эскалации теряться не должны (§9).
              */}
              {dialog.status === "escalated" ? (
                <>
                  {" · "}
                  <span className="text-accent-text font-medium">
                    эскалация: {dialog.escalationReason}
                  </span>
                </>
              ) : null}
            </div>
          </div>
          <div className="flex-none">
            <WindowBadge dialog={dialog} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/*
            Позвать администратора к диалогу.

            Автоматическое напоминание уходит через полчаса ожидания и один
            раз. Пока полчаса не прошли, растолкать было нечем — звонили
            голосом. Кнопка шлёт тот же push, что и эскалация, и только
            администраторам: отвечает пациенту администратор.
          */}
          <button
            type="button"
            disabled={pinging}
            onClick={() => {
              setPinging(true);
              setPing(null);
              void callAdminsDb(dialog.id)
                .then((res) =>
                  setPing({
                    dialogId: dialog.id,
                    /*
                      Про push говорим отдельно: уведомление в системе есть
                      всегда, а на телефон оно уходит только тем, кто разрешил
                      его в браузере. «Позвали» без этой оговорки читается как
                      «телефон зазвонил», и человека ждут зря.
                    */
                    text: res.ok
                      ? res.pushed > 0
                        ? `Позвали администраторов: ${res.sent}, push ушёл ${res.pushed}`
                        : `Позвали администраторов: ${res.sent}. Push ни на один телефон не ушёл — ни у кого нет подписки на уведомления.`
                      : res.error,
                  }),
                )
                .catch(() =>
                  setPing({ dialogId: dialog.id, text: "Не удалось связаться с сервером" }),
                )
                .finally(() => setPinging(false));
            }}
            title="Отправить администраторам push: пациент ждёт ответа"
            className="border-border text-text-muted hover:bg-hover flex-none rounded-md border px-2.5 py-1 text-2xs disabled:opacity-50"
          >
            {pinging ? "Зовём…" : "Позвать админа"}
          </button>
          {/*
            Выключатель агента — насовсем, а не на четыре часа.

            В пациентский канал пишут и сотрудники клиники между собой:
            «придёт Гулбарият, взять ОАК, оплату не брать». Агент отвечает им
            как пациенту и понять этого не может — отличить сотрудника от
            пациента ему нечем. Человеку есть, поэтому решение за ним, и срок
            у него не истекает.
          */}
          <button
            type="button"
            onClick={() => setAgentEnabled(dialog.id, Boolean(dialog.agentDisabled))}
            title={
              dialog.agentDisabled
                ? "Включить агента в этом диалоге — дальше всё работает как раньше"
                : "Выключить агента в этом диалоге навсегда: он не ответит ни сейчас, ни через четыре часа"
            }
            className={`flex-none rounded-md border px-2.5 py-1 text-2xs ${
              dialog.agentDisabled
                ? "border-accent text-accent-text hover:bg-accent-tint"
                : "border-border text-text-muted hover:bg-hover"
            }`}
          >
            {dialog.agentDisabled ? "Агент выключен" : "Выключить агента"}
          </button>
          {dialog.status !== "bot" && !dialog.agentDisabled ? (
            <button
              type="button"
              onClick={() => returnToBot(dialog.id)}
              /* Срок берём из самого правила: подпись не должна отставать от него. */
              title={`Снять паузу агента: после ручного ответа он молчит ${HANDBACK_HOURS} ч, потом диалог возвращается сам`}
              className="border-border text-text-muted hover:bg-hover flex-none rounded-md border px-2.5 py-1 text-2xs"
            >
              Вернуть агенту
            </button>
          ) : null}
        </div>
      </div>

      <ContactPanel key={dialog.id} dialog={dialog} onChanged={refresh} />

      <div className="flex-1 overflow-auto px-5 py-4">
        <div className="flex flex-col gap-3">
          {dialog.totalMessages && dialog.totalMessages > dialog.messages.length ? (
            // История никуда не делась — просто не грузим её целиком каждые
            // несколько секунд. Говорим об этом прямо, чтобы не выглядело
            // как потеря переписки.
            <p className="text-text-subtle text-center text-2xs">
              Показаны последние {dialog.messages.length} из {dialog.totalMessages} сообщений
            </p>
          ) : null}
          {dialog.messages.map((m) => {
            const mine = m.from !== "patient";
            return (
              <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                <div className="max-w-[78%]">
                  <div
                    className={`rounded-xl px-3.5 py-2 text-sm leading-snug ${
                      m.from === "patient" ? "bg-surface border-border border" : "bg-raise text-text"
                    }`}
                  >
                    {m.text}
                    {m.attachments.length ? (
                      <div className="mt-2 flex flex-col gap-2">
                        {m.attachments.map((a, i) => (
                          <Attachment key={`${m.id}-${i}`} a={a} />
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className={`num text-text-subtle mt-1 text-2xs ${mine ? "text-right" : ""}`}>
                    {m.from === "bot" ? "агент · " : m.from === "staff" ? "вы · " : ""}
                    {m.at}
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={endRef} />
        </div>
      </div>

      {dialog.agentDraft ? (
        <div className="border-border bg-accent-tint flex-none border-t px-5 py-3">
          <div className="text-accent-text mb-1.5 text-2xs font-medium">
            Черновик агента — проверьте перед отправкой
          </div>
          <p className="text-text mb-2.5 text-sm leading-snug">{dialog.agentDraft}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => sendMessage(dialog.id, dialog.agentDraft!)}
              className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-3 py-1.5 text-sm font-medium"
            >
              Отправить
            </button>
            <button
              type="button"
              onClick={() => setText(dialog.agentDraft!)}
              className="border-border text-text-muted hover:bg-hover rounded-md border px-3 py-1.5 text-sm"
            >
              Изменить
            </button>
          </div>
        </div>
      ) : null}

      {/* Результат доставки. Молчаливый «успех» при неотправленном сообщении —
          худший исход: администратор будет напрасно ждать ответа пациента. */}
      {sendError ? (
        <div className="border-border-soft bg-hover text-accent-text flex-none border-t px-5 py-2 text-xs">
          {sendError}
        </div>
      ) : null}

      {/*
        Ушёл ли вызов администраторов — тем же местом и по той же причине.

        Ответ помнит, к какому диалогу он относится: гасить его эффектом при
        смене диалога значило бы дописывать состояние в отрисовку, а перенести
        сообщение на чужую переписку нельзя — «позвали» под другим пациентом
        читается как отправленный туда push.
      */}
      {ping && ping.dialogId === dialog.id ? (
        <div className="border-border-soft bg-hover text-text-muted flex-none border-t px-5 py-2 text-xs">
          {ping.text}
        </div>
      ) : null}

      {/* Композер: окно открыто — свободный текст; закрыто — только шаблоны. */}
      {dialog.windowOpen ? (
        <div className="border-border flex-none border-t px-5 py-3">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {quickReplies.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setText(q)}
                className="border-border text-text-muted hover:bg-hover truncate rounded-md border px-2 py-1 text-2xs"
              >
                {q.length > 34 ? q.slice(0, 32) + "…" : q}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="Ответить вручную…"
              className="border-border-input bg-surface placeholder:text-text-subtle flex-1 rounded-md border px-3 py-2 text-sm outline-none"
            />
            <button
              type="button"
              onClick={submit}
              disabled={!text.trim()}
              className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-4 py-2 text-sm font-medium disabled:opacity-45"
            >
              Отправить
            </button>
          </div>
        </div>
      ) : (
        <div className="border-border flex-none border-t px-5 py-3">
          <p className="text-text-muted mb-2 text-xs">
            24-часовое окно закрыто. Написать первым можно только утверждённым
            шаблоном.
          </p>
          {approvedTemplates.length === 0 ? (
            <p className="text-text-subtle text-sm">
              Нет утверждённых шаблонов.{" "}
              <Link href="/settings/templates" className="text-accent-text hover:underline">
                Добавить
              </Link>
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {approvedTemplates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => sendMessage(dialog.id, t.body)}
                  className="border-accent-border bg-accent-tint text-accent-text hover:bg-accent hover:text-accent-contrast rounded-md border px-3 py-1.5 text-sm font-medium"
                >
                  {t.title}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


export default function InboxPage() {
  const db = useDb();
  const [filter, setFilter] = useState("need");
  const [syncing, setSyncing] = useState(false);

  /**
   * Тихое обновление списка. Без него новые сообщения появлялись только после
   * перезахода на страницу: инбокс загружался один раз при монтировании.
   */
  const refresh = useCallback(() => {
    setSyncing(true);
    getConversations()
      .then(hydrateDialogs)
      .catch(() => {})
      .finally(() => setSyncing(false));
  }, []);

  useEffect(() => {
    const timer = setInterval(refresh, 6000);
    return () => clearInterval(timer);
  }, [refresh]);
  // Ничего не выбрано по умолчанию: раньше здесь стоял id выдуманного диалога,
  // и при пустом инбоксе экран пытался открыть несуществующую переписку.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  const list = useMemo(
    () => db.dialogs.filter((d) => dialogMatchesFilter(d, filter)),
    [db.dialogs, filter],
  );
  const selected = db.dialogs.find((d) => d.id === selectedId) ?? null;
  const patient = selected?.patientId ? findPatient(selected.patientId) : undefined;

  function open(id: string) {
    setSelectedId(id);
    markDialogRead(id);
  }

  return (
    <div className="flex h-full min-h-0 flex-1">
      <div
        className={`border-border flex w-[300px] flex-none flex-col border-r max-md:w-full ${selected ? "max-md:hidden" : ""}`}
      >
        <div className="border-border flex-none border-b px-4 py-3.5">
          <div className="flex items-center justify-between">
            <h1 className="text-md font-medium">Диалоги</h1>
            <button
              type="button"
              onClick={() => setComposing(true)}
              className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-2.5 py-1 text-xs font-medium"
            >
              + Написать
            </button>
          </div>
          <div className="mt-2.5 flex flex-wrap gap-1">
            {syncing ? <span className="text-text-subtle self-center text-2xs">обновляем…</span> : null}
            {DIALOG_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={`rounded-md px-2 py-1 text-2xs ${
                  filter === f.id ? "bg-nav-active text-accent-text font-medium" : "text-text-muted hover:bg-hover"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-auto">
          {list.length === 0 ? (
            <p className="text-text-muted px-4 py-6 text-sm">В этом фильтре пусто.</p>
          ) : (
            list.map((d) => (
              <DialogRow key={d.id} dialog={d} active={d.id === selectedId} onClick={() => open(d.id)} />
            ))
          )}
        </div>
      </div>

      <div className={`min-w-0 flex-1 ${selected ? "" : "max-md:hidden"}`}>
        {selected ? (
          <Thread dialog={selected} onBack={() => setSelectedId(null)} refresh={refresh} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-text-subtle text-sm">Выберите диалог слева.</p>
          </div>
        )}
      </div>

      <div className="border-border w-[320px] flex-none overflow-auto border-l px-5 py-5 max-xl:hidden">
        {patient ? (
          <PatientCardBody patientId={patient.id} />
        ) : selected ? (
          <div>
            <div className="text-md font-medium">Пациент не опознан</div>
            <p className="text-text-muted mt-2 text-sm leading-snug">
              Номер не найден в базе. Один номер бывает у семьи — свяжите диалог
              с карточкой вручную, чтобы не приклеить чужую историю.
            </p>
            <Link href="/patients" className="text-accent-text mt-3 inline-block text-sm hover:underline">
              Найти пациента
            </Link>
          </div>
        ) : null}
      </div>

      {composing ? <ComposeOverlay onClose={() => setComposing(false)} /> : null}
    </div>
  );
}
