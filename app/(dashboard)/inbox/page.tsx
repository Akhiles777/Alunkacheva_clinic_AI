"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { HANDBACK_HOURS } from "@/lib/agent/handback-rule";
import { reportMaybeStale } from "@/lib/client/stale-build";
import { URGENT_WAIT_MS, waitLabel } from "@/lib/inbox/waiting";
import { HOTKEYS, hotkeyAction, nextWaiting, step } from "@/lib/inbox/hotkeys";
import { AGENT_DOES, AGENT_DOES_NOT, ARTICLES } from "@/lib/help/topics";
import {
  CHANNEL_LABEL,
  DIALOG_FILTERS,
  DIALOG_STATUS_LABEL,
  dialogMatchesFilter,
  sortDialogs,
} from "@/app/_data/inbox";
import {
  activeNotes,
  findPatient,
  hydrateDialogs,
  markDialogRead,
  markDialogsRead,
  closeDialogs,
  flushReadMarks,
  editMessage,
  removeMessage,
  resendMessage,
  setDraft,
  type OutgoingAttachment,
  returnToBot,
  setAgentEnabled,
  sendMessage,
  sendTemplate,
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
import { Composer } from "./composer";
import { Hint } from "../_components/hint";
import { DialogTools } from "./dialog-tools";
import { cancelDialogTask } from "./dialog-actions";
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
/**
 * Фотография с честным запасным путём.
 *
 * Не открылась — браузер рисует сломанный значок и молчит, а администратор
 * видит пустой квадрат там, где пациент прислал направление, и не знает, у
 * кого поломка: у него, у нас или у пациента. Показываем ссылку словами —
 * файл чаще всего открывается по ней, а если нет, то ясно, что делать.
 */
function Photo({ href, label }: { href: string; label: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-accent-text text-2xs underline decoration-dotted"
      >
        Фотография не открылась — скачать файл
      </a>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={href}
        alt={label}
        loading="lazy"
        onError={() => setBroken(true)}
        className="border-border max-h-56 rounded-lg border object-cover"
      />
    </a>
  );
}

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
    return <Photo href={a.href} label={a.label} />;
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
  now,
  chosen,
  onChoose,
  selecting,
}: {
  dialog: Dialog;
  active: boolean;
  onClick: () => void;
  /** Текущее время, общее на весь список: у каждой строки своё шло бы вразнобой. */
  now: number;
  chosen: boolean;
  onChoose: (on: boolean) => void;
  /** Хоть что-то выбрано — показываем галочки у всех строк. */
  selecting: boolean;
}) {
  /**
   * Через снимок стора, а не прямым чтением модуля: на сервере состояние
   * пустое, к гидрации на клиенте уже заполнено, и React выбрасывает
   * серверную разметку целиком — на экране это выглядит как рывок и долгая
   * загрузка.
   */
  const db = useDb();
  const patient = dialog.patientId ? db.patients.find((p) => p.id === dialog.patientId) : undefined;
  const notes = patient ? activeNotes(patient) : [];
  const unread = dialog.unreadCount ?? 0;
  /**
   * Ожидание считаем на экране, а не на сервере: сервер отдаёт МОМЕНТ, с
   * которого человек ждёт, и минуты набегают между обновлениями сами. Иначе
   * «ждёт 12 мин» стояло бы неподвижно по шесть секунд и врало бы к концу.
   */
  const wait = dialog.waitingSince ? waitLabel(now - Date.parse(dialog.waitingSince)) : null;
  const urgent =
    dialog.waitingSince !== null &&
    dialog.waitingSince !== undefined &&
    now - Date.parse(dialog.waitingSince) >= URGENT_WAIT_MS;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group/row w-full border-b border-border-soft px-4 py-3 text-left last:border-b-0 ${
        active ? "bg-nav-active" : "hover:bg-hover"
      }`}
    >
      <div className="flex items-baseline gap-2">
        {/*
          Галочка появляется по наведению и остаётся, пока идёт выбор: в
          обычной работе она только мешает читать список, а в конце смены без
          неё каждый диалог закрывается отдельным открытием переписки.

          На телефоне наведения нет вовсе, поэтому там она видна всегда: иначе
          массовый выбор на мобильном не начать ничем.
        */}
        <span
          role="checkbox"
          aria-checked={chosen}
          tabIndex={0}
          aria-label="Выбрать диалог"
          onClick={(e) => {
            e.stopPropagation();
            onChoose(!chosen);
          }}
          onKeyDown={(e) => {
            if (e.key === " " || e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              onChoose(!chosen);
            }
          }}
          className={`border-border-strong flex h-3.5 w-3.5 flex-none items-center justify-center self-center rounded-sm border text-2xs ${
            chosen ? "bg-accent text-accent-contrast border-accent" : "bg-surface"
          } ${
            selecting || chosen ? "" : "opacity-0 group-hover/row:opacity-100 max-md:opacity-100"
          }`}
        >
          {chosen ? "✓" : ""}
        </span>
        <span className="truncate text-sm font-medium">{dialog.name}</span>
        <span className="num text-text-subtle ml-auto flex-none text-2xs">{dialog.at}</span>
        {/*
          Число, а не точка. Точка отвечает только на «есть ли новое», а
          администратор решает, куда идти первым: три сообщения подряд и одно
          «спасибо» — это разные диалоги. Так устроен любой мессенджер, и
          привычку ломать незачем.
        */}
        {unread > 0 ? (
          <span className="bg-accent text-accent-contrast num flex-none rounded-full px-1.5 py-px text-2xs font-medium">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : dialog.unread ? (
          <span aria-hidden className="bg-accent h-1.5 w-1.5 flex-none rounded-full" />
        ) : null}
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
      <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <span className="text-text-subtle text-2xs">{CHANNEL_LABEL[dialog.channel]}</span>
        {dialog.status === "escalated" ? (
          <span className="text-accent-text text-2xs font-medium">· нужен человек</span>
        ) : dialog.agentDraft ? (
          <span className="text-accent-text text-2xs font-medium">· черновик готов</span>
        ) : (
          <span className="text-text-subtle text-2xs">· {DIALOG_STATUS_LABEL[dialog.status]}</span>
        )}
        {/*
          Сколько человек ждёт — прямо в строке. Без этого числа список
          отвечает на вопрос «кто написал последним», а работать надо по
          вопросу «кто ждёт дольше всех».
        */}
        {wait ? (
          <span className={`num text-2xs ${urgent ? "text-accent-text font-medium" : "text-text-subtle"}`}>
            · {wait}
          </span>
        ) : null}
        {dialog.practice ? (
          /* Учебная переписка. Метка обязана быть видна раньше, чем человек
             начнёт печатать: иначе он однажды решит, что тренируется, а
             написал настоящему пациенту — или наоборот. */
          <span className="border-border text-text-muted rounded-sm border px-1 py-px text-2xs">
            тренировка
          </span>
        ) : null}
        {dialog.reminder ? (
          <span className="text-accent-text text-2xs font-medium">· напоминание</span>
        ) : null}
        {(dialog.scheduled ?? 0) > 0 ? (
          <span className="text-text-subtle text-2xs">· отложено {dialog.scheduled}</span>
        ) : null}
        {(dialog.noteCount ?? 0) > 0 ? (
          <span className="text-text-subtle text-2xs">· заметки {dialog.noteCount}</span>
        ) : null}
        {/* Новый человек: с ним ещё ничего не связывает, и уходит он молча. */}
        {dialog.firstTime && dialog.unread ? (
          <span className="border-border text-text-muted rounded-sm border px-1 py-px text-2xs">
            впервые
          </span>
        ) : null}
      </div>
    </button>
  );
}

/**
 * Канал диалога в термины отправки.
 *
 * Пределы файлов и сама возможность их отправить зависят от канала, и
 * называть его тем же словом, что и в переписке, надёжнее, чем угадывать по
 * подписи на экране.
 */
const CHANNEL_FOR_SEND: Record<string, "WHATSAPP" | "TELEGRAM" | "INSTAGRAM"> = {
  whatsapp: "WHATSAPP",
  telegram: "TELEGRAM",
  instagram: "INSTAGRAM",
};

/**
 * Что стало с нашим сообщением.
 *
 * Провайдер сообщает это вебхуком, и до сих пор мы всё выбрасывали: любое своё
 * сообщение выглядело отправленным, а «не дошло» было не отличить от
 * «прочитано». Слова, а не галочки: «✓✓» без подписи каждый читает по-своему.
 */
function Delivery({ state, reason }: { state?: string; reason?: string }) {
  if (!state) return null;
  if (state === "failed") {
    return (
      <span className="text-accent-text" title={reason ?? undefined}>
        не ушло{reason ? ` · ${reason}` : ""}
      </span>
    );
  }
  const label =
    state === "sending"
      ? "отправляется…"
      : state === "sent"
        ? "отправлено"
        : state === "delivered"
          ? "доставлено"
          : "прочитано";
  return <span>{label}</span>;
}

/** Правка отправленного сообщения прямо в переписке. */
function MessageEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={value}
        rows={2}
        onChange={(e) => setValue(e.target.value)}
        className="border-border-input bg-surface resize-none rounded-md border px-2 py-1 text-sm outline-none"
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onSave(value)}
          disabled={!value.trim() || value.trim() === initial.trim()}
          className="bg-accent text-accent-contrast rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-45"
        >
          Сохранить
        </button>
        <button type="button" onClick={onCancel} className="text-text-subtle hover:text-text text-xs">
          Отмена
        </button>
      </div>
    </div>
  );
}

/**
 * Шпаргалка по «?».
 *
 * Сочетание, о котором никто не знает, не ускоряет работу: администратор
 * пользуется тем, что видел. Список один и тот же в коде и на экране
 * (`HOTKEYS`) — расходиться им нельзя, иначе шпаргалка врёт.
 */
function Hotkeys({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="overlay-scrim fixed inset-0 z-50 flex items-start justify-center px-4 pt-[10vh]"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        className="border-border bg-surface max-h-[80vh] w-full max-w-[520px] overflow-auto rounded-xl border p-5"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Подсказка по работе"
      >
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-md font-medium">Подсказка</h2>
          <button type="button" onClick={onClose} className="text-text-subtle hover:text-text text-xs">
            закрыть
          </button>
        </div>

        <div className="text-text-subtle mb-1.5 text-2xs">Клавиши</div>
        <ul className="mb-4 flex flex-col gap-1.5">
          {HOTKEYS.map((h) => (
            <li key={h.keys} className="flex items-baseline gap-3 text-xs">
              <kbd className="num border-border text-text-muted w-[110px] flex-none rounded-sm border px-1.5 py-px text-2xs">
                {h.keys}
              </kbd>
              <span className="text-text-muted">{h.what}</span>
            </li>
          ))}
        </ul>

        {/*
          Порядок работы — здесь, а не в общей справке: он нужен в момент
          работы и на том же экране. Заголовок — задача, строка под ним —
          готовый ответ; подробности человек и так делает руками.
        */}
        <div className="text-text-subtle mb-1.5 text-2xs">Как сделать</div>
        <ul className="mb-4 flex flex-col gap-2">
          {ARTICLES.map((a) => (
            <li key={a.id}>
              <div className="text-xs font-medium">{a.title}</div>
              <div className="text-text-muted text-xs leading-snug">{a.answer}</div>
            </li>
          ))}
        </ul>

        <div className="text-text-subtle mb-1.5 text-2xs">Ассистент</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <div className="text-text-subtle mb-1 text-2xs">отвечает сам</div>
            <ul className="text-text-muted flex list-disc flex-col gap-0.5 pl-4 text-xs leading-snug">
              {AGENT_DOES.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
          <div>
            <div className="text-text-subtle mb-1 text-2xs">отдаёт человеку</div>
            <ul className="text-text-muted flex list-disc flex-col gap-0.5 pl-4 text-xs leading-snug">
              {AGENT_DOES_NOT.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            onClose();
            window.dispatchEvent(new Event("start-tour"));
          }}
          className="border-border text-text-muted hover:bg-hover mt-4 rounded-md border px-2.5 py-1 text-xs"
        >
          Показать знакомство с платформой заново
        </button>
      </div>
    </div>
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
  const [sendError, setSendError] = useState<string | null>(null);
  /** На какое сообщение отвечаем и какое правим — по одному за раз. */
  const [replyTo, setReplyTo] = useState<{ id: string; preview: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  /** Пересоздать композер: черновик агента положили в поле ввода. */
  const [composerKey, setComposerKey] = useState(0);
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
    getInboxTemplates()
      .then((t) => {
        if (!alive) return;
        setApprovedTemplates(t.approved);
        setQuickReplies(t.quickReplies);
      })
      // Шаблоны не пришли — молча: без них поле ввода работает как обычно, а
      // говорить об этом человеку нечего, делать он всё равно ничего не станет.
      .catch(reportMaybeStale);
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Отправка из композера.
   *
   * Текст и файлы уходят вместе; неудача видна и полосой, и на самом
   * сообщении в переписке — «не ушло» с причиной. Набранное при этом не
   * пропадает: сообщение остаётся в разговоре, его можно отправить заново.
   */
  function submit(text: string, files: OutgoingAttachment[]) {
    if (!dialog.windowOpen) return;
    const quoted = replyTo;
    setReplyTo(null);
    void sendMessage(dialog.id, text, {
      files,
      replyToMessageId: quoted?.id ?? null,
      replyToPreview: quoted?.preview ?? null,
    }).then((res) => {
      setSendError(res.ok ? null : (res.error ?? "Сообщение не отправлено"));
    });
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
            <div data-tour="dialog-status" className="text-text-subtle truncate text-2xs">
              {CHANNEL_LABEL[dialog.channel]} · {DIALOG_STATUS_LABEL[dialog.status]}{" "}
              {/* «Ведёт агент» и «ведёт человек» — не одно и то же, и разница
                  решает, отвечать сейчас или нет. */}
              <Hint id={dialog.status === "human" ? "agentHuman" : "agentActive"} />
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
              {dialog.practice ? (
                <>
                  {" · "}
                  <span className="text-text-muted font-medium">
                    тренировка: наружу ничего не уходит
                  </span>
                </>
              ) : null}
              {dialog.status === "escalated" ? (
                <>
                  {" · "}
                  <span className="text-accent-text font-medium">
                    эскалация: {dialog.escalationReason}
                  </span>
                </>
              ) : null}
              {/*
                Состояние агента — в строке сведений, а не только в подписи
                кнопки. «Я не знаю, работает бот или нет» — вопрос, на который
                экран обязан отвечать сам, не заставляя нажимать.
              */}
              {dialog.agentDisabled ? (
                <>
                  {" · "}
                  <span className="text-accent-text font-medium">агент выключен</span>
                </>
              ) : dialog.agentPausedUntil ? (
                /*
                  Пауза после ответа сотрудника правильная: бот не перебивает
                  администратора. Но со стороны она неотличима от поломки —
                  человек пишет в диалог, ответа нет, и вывод один: «бот не
                  работает». Состояние должно быть на экране, а не в скрипте.
                */
                <>
                  {" · "}
                  <span className="text-accent-text font-medium">
                    агент молчит до {dialog.agentPausedUntil}
                  </span>{" "}
                  <Hint id="agentPaused" />
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
                  setPing({
                    dialogId: dialog.id,
                    // Что произошло и что делать: одного «не удалось» мало.
                    text: "Не дозвались до сервера — администраторов не позвали. Нажмите ещё раз.",
                  }),
                )
                .finally(() => setPinging(false));
            }}
            data-tour="call-admin"
            title="Отправить администраторам push: пациент ждёт ответа"
            className="border-border text-text-muted hover:bg-hover flex-none rounded-md border px-2.5 py-1 text-2xs disabled:opacity-50"
          >
            {pinging ? "Зовём…" : "Позвать админа"}
          </button>
          <Hint id="callAdmin" className="self-center" />
          {/*
            Выключатель агента — насовсем, а не на четыре часа.

            В пациентский канал пишут и сотрудники клиники между собой:
            «придёт Гулбарият, взять ОАК, оплату не брать». Агент отвечает им
            как пациенту и понять этого не может — отличить сотрудника от
            пациента ему нечем. Человеку есть, поэтому решение за ним, и срок
            у него не истекает.
          */}
          <button
            data-tour="agent-off"
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
          <Hint id="agentOff" className="self-center" />
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
          {/* Подсказка живёт при своей кнопке: одинокий «?» объясняет то,
              чего на экране нет, и сам становится загадкой. */}
          {dialog.status !== "bot" && !dialog.agentDisabled ? (
            <Hint id="returnToBot" className="self-center" />
          ) : null}
        </div>
      </div>

      <ContactPanel key={dialog.id} dialog={dialog} onChanged={refresh} />

      {/*
        Назревшее напоминание — первым, что видно при открытии: ради этого
        момента его и ставили. Кнопка «сделано» убирает его и опускает диалог
        обратно в общий порядок.
      */}
      {dialog.reminder ? (
        <div className="border-accent-border bg-accent-tint flex flex-none flex-wrap items-center gap-2 border-b px-5 py-2">
          <span className="text-accent-text text-xs font-medium">Напоминание:</span>
          <span className="text-text min-w-0 flex-1 text-xs">{dialog.reminder.body}</span>
          <button
            type="button"
            onClick={() => {
              const id = dialog.reminder?.id;
              if (!id) return;
              void cancelDialogTask(id).then(refresh);
            }}
            className="border-border bg-surface text-text-muted hover:bg-hover rounded-md border px-2 py-1 text-2xs"
          >
            Сделано
          </button>
        </div>
      ) : null}



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
              <div key={m.id} className={`group flex ${mine ? "justify-end" : "justify-start"}`}>
                <div className="max-w-[78%]">
                  {m.replyToPreview ? (
                    /* Цитата: без неё ответ на третью реплику из пяти читается как ответ на последнюю. */
                    <div className="border-border-soft text-text-subtle mb-1 truncate border-l-2 pl-2 text-2xs">
                      {m.replyToPreview}
                    </div>
                  ) : null}
                  <div
                    /*
                      Переносы строк сохраняем: администратор пишет ответ
                      абзацами, а в переписке всё склеивалось в одну строку —
                      экран показывал не то, что ушло пациенту.
                    */
                    className={`rounded-xl px-3.5 py-2 text-sm leading-snug whitespace-pre-wrap ${
                      m.from === "patient" ? "bg-surface border-border border" : "bg-raise text-text"
                    }`}
                  >
                    {editing === m.id ? (
                      <MessageEditor
                        initial={m.text}
                        onCancel={() => setEditing(null)}
                        onSave={(next) =>
                          void editMessage(dialog.id, m.id, next).then((res) => {
                            if (res.ok) setEditing(null);
                            else setSendError(res.error ?? "Не исправилось");
                          })
                        }
                      />
                    ) : (
                      <>
                        {m.text}
                        {m.attachments.length ? (
                          <div className="mt-2 flex flex-col gap-2">
                            {m.attachments.map((a, i) => (
                              <Attachment key={`${m.id}-${i}`} a={a} />
                            ))}
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                  <div
                    className={`num text-text-subtle mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs ${
                      mine ? "justify-end" : ""
                    }`}
                  >
                    <span>
                      {m.from === "bot" ? "агент · " : m.from === "staff" ? "вы · " : ""}
                      {m.at}
                      {m.edited ? " · исправлено" : ""}
                    </span>
                    {mine ? <Delivery state={m.delivery} reason={m.failureReason} /> : null}
                    {mine && m.delivery === "failed" ? (
                      /* Текст никуда не делся — он в самом сообщении; повтор
                         не создаёт второе и не отправит дважды. */
                      <button
                        type="button"
                        onClick={() =>
                          void resendMessage(dialog.id, m.id).then((res) => {
                            if (!res.ok) setSendError(res.error ?? "Снова не ушло");
                          })
                        }
                        className="text-accent-text hover:underline"
                      >
                        Отправить ещё раз
                      </button>
                    ) : null}
                    {/*
                      Действия появляются при наведении: они нужны редко, а
                      переписка должна читаться, а не пестреть кнопками.
                    */}
                    <span className="hidden gap-2 group-hover:flex">
                      <button
                        type="button"
                        onClick={() =>
                          setReplyTo({ id: m.id, preview: m.text || m.attachments[0]?.label || "вложение" })
                        }
                        className="hover:text-text"
                      >
                        Ответить
                      </button>
                      {mine && m.canRecall && m.attachments.length === 0 ? (
                        <button type="button" onClick={() => setEditing(m.id)} className="hover:text-text">
                          Исправить
                        </button>
                      ) : null}
                      {mine && m.canRecall ? (
                        <button
                          type="button"
                          onClick={() =>
                            void removeMessage(dialog.id, m.id).then((res) => {
                              if (!res.ok) setSendError(res.error ?? "Не удалилось");
                            })
                          }
                          className="hover:text-text"
                        >
                          Удалить
                        </button>
                      ) : null}
                    </span>
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
              onClick={() => {
                /**
                 * Черновик агента переезжает в поле ввода. Пишем его в
                 * черновик диалога и пересоздаём композер: так текст не
                 * зависит от того, что там было набрано минуту назад.
                 */
                setDraft(dialog.id, dialog.agentDraft!);
                setComposerKey((n) => n + 1);
              }}
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

      {/*
        Заметки, передача и отложенное — подписью ПОД перепиской, а не панелью
        над ней: ими пользуются несколько раз за смену, и постоянное меню
        забирает место у того, ради чего сюда смотрят.
      */}
      {/* Композер: окно открыто — свободный текст; закрыто — только шаблоны. */}
      {dialog.windowOpen ? (
        <Composer
          key={`${dialog.id}-${composerKey}`}
          dialogId={dialog.id}
          channel={CHANNEL_FOR_SEND[dialog.channel]}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          onSend={submit}
          quickReplies={quickReplies}
          templates={approvedTemplates}
          onSendTemplate={(templateId, title) =>
            void sendTemplate(dialog.id, templateId, title).then((res) => {
              if (!res.ok) setSendError(res.error ?? "Шаблон не отправлен");
            })
          }
        />
      ) : (
        <div className="border-border flex-none border-t px-5 py-3">
          <p className="text-text-muted mb-2 flex flex-wrap items-center gap-1.5 text-xs">
            24-часовое окно закрыто. Написать первым можно только утверждённым шаблоном.
            <Hint id="window24" />
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
                  onClick={() =>
                    void sendTemplate(dialog.id, t.id, t.title).then((res) => {
                      /**
                       * Шаблон мог не уйти: не хватило данных для переменных
                       * или канал не принял. Молчать об этом нельзя —
                       * администратор уверен, что написал, а пациент ничего не
                       * получил.
                       */
                      if (!res.ok) {
                        setPing({ dialogId: dialog.id, text: res.error ?? "Шаблон не отправлен" });
                      }
                    })
                  }
                  className="border-accent-border bg-accent-tint text-accent-text hover:bg-accent hover:text-accent-contrast rounded-md border px-3 py-1.5 text-sm font-medium"
                >
                  {t.title}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Подпись под перепиской: заметка, передача коллеге, отложенное. */}
      <DialogTools dialogId={dialog.id} onChanged={refresh} />
    </div>
  );
}


export default function InboxPage() {
  const db = useDb();
  const [filter, setFilter] = useState("need");

  /**
   * Часы списка. Ожидание («ждёт 12 мин») набегает между обновлениями, и без
   * своего тика надпись стояла бы неподвижно до следующего ответа сервера.
   * Полминуты хватает: минуты меняются медленнее.
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  /**
   * Тихое обновление списка. Без него новые сообщения появлялись только после
   * перезахода на страницу: инбокс загружался один раз при монтировании.
   */
  /**
   * Список обновляется молча.
   *
   * Надпись «обновляем…» мигала каждые шесть секунд у самых фильтров и
   * дёргала взгляд ровно там, где человек читает. Обновление и так видно по
   * самому списку; отдельный признак нужен, только когда что-то пошло не так,
   * а это отдельное сообщение.
   */
  const refresh = useCallback(() => {
    // Тем же кругом повторяем отметки прочтения, которые не легли в базу:
    // сеть моргнула или приложение перезапускалось — человека это не касается.
    flushReadMarks();
    getConversations()
      .then(hydrateDialogs)
      .catch((e: unknown) => {
        // Список не пришёл — молча: следующий круг через шесть секунд. Но если
        // вкладка на старой сборке, круги не помогут, и сторож это заметит.
        reportMaybeStale(e);
      });
  }, []);

  useEffect(() => {
    const timer = setInterval(refresh, 6000);
    // Вернулись в приложение или починилась сеть — обновляемся сразу, не ожидая
    // круга: заодно уходят отметки прочтения, накопившиеся, пока связи не было.
    const onBack = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onBack);
    window.addEventListener("online", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onBack);
      window.removeEventListener("online", refresh);
    };
  }, [refresh]);
  // Ничего не выбрано по умолчанию: раньше здесь стоял id выдуманного диалога,
  // и при пустом инбоксе экран пытался открыть несуществующую переписку.
  /**
   * Переписку можно назвать адресом: `/inbox?d=<id>`.
   *
   * Так её открывает глобальный поиск (⌘K) и любая ссылка с другого экрана —
   * иначе «найти диалог» означало «перейти в инбокс и искать глазами», то
   * есть ровно то, ради чего администратор открывает WhatsApp на телефоне.
   * Читаем адрес при первом рендере, а не эффектом: выбор — это начальное
   * состояние экрана, а не изменение уже показанного.
   */
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("d"),
  );
  // Адрес чистим сразу: перезагрузка не должна возвращать к тому диалогу,
  // с которого человек уже ушёл.
  useEffect(() => {
    if (window.location.search) window.history.replaceState(null, "", "/inbox");
  }, []);
  const [composing, setComposing] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  /**
   * Выбранные строки для массовых действий. Пусто — режима выбора нет вовсе:
   * галочки у каждой строки в обычной работе только мешают читать список.
   */
  const [chosen, setChosen] = useState<string[]>([]);

  /**
   * Порядок — по ожиданию, а не по времени последнего сообщения: пациент,
   * написавший сорок минут назад, уезжал вниз под свежую переписку, которую
   * только что закрыли, и дольше всех ждущего не было видно вовсе.
   */
  const list = useMemo(() => {
    const matching = db.dialogs.filter((d) => dialogMatchesFilter(d, filter));
    /**
     * Открытая переписка остаётся в списке, даже если перестала подходить под
     * фильтр. Иначе она исчезает прямо под курсором: открыл диалог из «Нужен
     * ответ» — он тут же прочитан и пропал, список дёрнулся, стрелки повели
     * не туда, а человек читает сообщение и не понимает, куда делась строка.
     */
    const open = selectedId ? db.dialogs.find((d) => d.id === selectedId) : undefined;
    const rows = open && !matching.some((d) => d.id === open.id) ? [...matching, open] : matching;
    return sortDialogs(rows);
  }, [db.dialogs, filter, selectedId]);
  const selected = db.dialogs.find((d) => d.id === selectedId) ?? null;
  const patient = selected?.patientId ? findPatient(selected.patientId) : undefined;

  function open(id: string) {
    setSelectedId(id);
    markDialogRead(id);
  }

  /**
   * Названный адресом диалог отмечаем прочитанным, когда он доехал.
   *
   * Сам выбор сделан ещё при первом рендере (см. `selectedId`), а список
   * приходит с сервера позже — отметку раньше ставить некуда. Ставим ровно
   * один раз на диалог: дальше это делает `open`.
   */
  const markedFromUrl = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId || markedFromUrl.current === selectedId) return;
    if (!db.dialogs.some((d) => d.id === selectedId)) return;
    markedFromUrl.current = selectedId;
    markDialogRead(selectedId);
  }, [selectedId, db.dialogs]);

  /**
   * Счётчик непрочитанных в заголовке вкладки — как в мессенджере.
   *
   * Платформа стоит приложением и неделями висит открытой в фоне. Пока число
   * жило только на экране, о новом сообщении узнавали, вернувшись к вкладке;
   * теперь оно видно в списке окон и на панели задач.
   */
  const waiting = useMemo(
    () => db.dialogs.filter((d) => d.unread && d.status !== "closed").length,
    [db.dialogs],
  );
  useEffect(() => {
    const base = "Диалоги";
    document.title = waiting > 0 ? `(${waiting}) ${base}` : base;
    return () => {
      document.title = base;
    };
  }, [waiting]);

  /**
   * Клавиатура. Решение о том, что делать с нажатием, принимает
   * `lib/inbox/hotkeys` — там же оно проверено тестами: горячая клавиша,
   * сработавшая во время набора ответа, стоит человеку набранного текста.
   */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const typing =
        !!el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable === true);
      const action = hotkeyAction({
        key: e.key,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        typing,
      });
      if (!action) return;

      if (action === "help") {
        e.preventDefault();
        setHelpOpen((v) => !v);
        return;
      }
      if (action === "escape") {
        if (helpOpen) setHelpOpen(false);
        else if (typing) (el as HTMLElement).blur();
        else setSelectedId(null);
        return;
      }
      if (action === "next" || action === "prev") {
        e.preventDefault();
        const id = step(list.map((d) => d.id), selectedId, action === "next" ? 1 : -1);
        if (id) open(id);
        return;
      }
      if (action === "nextWaiting") {
        e.preventDefault();
        const id = nextWaiting(
          list.map((d) => ({ id: d.id, waiting: d.unread })),
          selectedId,
        );
        if (id) open(id);
        return;
      }
      if (action === "reply") {
        e.preventDefault();
        // Курсор в поле ввода: «ответить» — это единственное, ради чего
        // открывают диалог, и тянуться к нему мышью незачем.
        document.querySelector<HTMLTextAreaElement>("[data-composer-input]")?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="flex h-full min-h-0 flex-1">
      {helpOpen ? <Hotkeys onClose={() => setHelpOpen(false)} /> : null}
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
          <div data-tour="dialog-filters" className="mt-2.5 flex flex-wrap gap-1">
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
            {/* Шпаргалка. Сочетание, о котором никто не знает, скорости не даёт. */}
            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              title="Горячие клавиши"
              className="border-border text-text-subtle hover:bg-hover self-center rounded-md border px-1.5 py-0.5 text-2xs"
            >
              ?
            </button>
          </div>
        </div>
        {/*
          Массовые действия по концу смены. Панель появляется только когда
          что-то выбрано: постоянная строка кнопок над списком забирает место
          у того, ради чего сюда смотрят.
        */}
        {chosen.length > 0 ? (
          <div className="border-border-soft bg-raise flex flex-none flex-wrap items-center gap-2 border-b px-4 py-2">
            <span className="text-text-muted text-2xs">Выбрано: {chosen.length}</span>
            <button
              type="button"
              onClick={() => {
                markDialogsRead(chosen);
                setChosen([]);
              }}
              className="border-border text-text-muted hover:bg-hover rounded-md border px-2 py-1 text-2xs"
            >
              Отметить прочитанными
            </button>
            <button
              type="button"
              onClick={() => {
                closeDialogs(chosen);
                setChosen([]);
              }}
              className="border-border text-text-muted hover:bg-hover rounded-md border px-2 py-1 text-2xs"
            >
              Закрыть
            </button>
            <button
              type="button"
              onClick={() => setChosen(list.map((d) => d.id))}
              className="text-text-subtle hover:text-text px-1 text-2xs"
            >
              Выбрать все
            </button>
            <button
              type="button"
              onClick={() => setChosen([])}
              className="text-text-subtle hover:text-text ml-auto px-1 text-2xs"
            >
              Снять выбор
            </button>
          </div>
        ) : null}

        <div className="flex-1 overflow-auto">
          {list.length === 0 ? (
            <p className="text-text-muted px-4 py-6 text-sm">В этом фильтре пусто.</p>
          ) : (
            list.map((d) => (
              <DialogRow
                key={d.id}
                dialog={d}
                active={d.id === selectedId}
                onClick={() => open(d.id)}
                now={now}
                chosen={chosen.includes(d.id)}
                onChoose={(on) =>
                  setChosen((prev) => (on ? [...prev, d.id] : prev.filter((x) => x !== d.id)))
                }
                selecting={chosen.length > 0}
              />
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

      <div
        data-tour="patient-card"
        className="border-border w-[320px] flex-none overflow-auto border-l px-5 py-5 max-xl:hidden"
      >
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
