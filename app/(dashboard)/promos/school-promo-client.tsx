"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import QRCode from "qrcode";
import { formatMoney, formatNumber } from "@/lib/format";
import type { PromoParticipant, SchoolPromoView } from "@/lib/server/promos";
import { Field, Group, SaveBar, TextInput, Textarea, Toggle } from "../settings/_components/ui";
import { PromoKnowledge } from "./promo-knowledge";
import {
  attachPatientToSchool,
  detachPatientFromSchool,
  findPatientsForPromo,
  markPromoDone,
  reviewPromoAttribution,
  revokePromoBonus,
  rotateSchoolToken,
  runPromoAiReview,
  saveSchool,
  saveSchoolPromo,
  setPromoParticipantSchool,
  unmarkPromoDone,
} from "./actions";

const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });
const shortFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
const whenFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const STATUS: Record<PromoParticipant["status"], { label: string; tone: string }> = {
  waiting: { label: "ждём визита", tone: "text-text-muted" },
  done: { label: "прошёл", tone: "text-text" },
  bonus: { label: "прошёл · бонус начислен", tone: "text-text font-medium" },
  reversed: { label: "бонус снят", tone: "text-accent-text" },
  no_school: { label: "без школы — бонуса нет", tone: "text-text-subtle" },
  returning: { label: "повторный пациент — бонуса нет", tone: "text-text-subtle" },
};

const HOW: Record<PromoParticipant["confidence"], string> = {
  MARKER: "метка",
  AI_EVIDENCE: "по переписке",
  MANUAL: "вручную",
};

export function SchoolPromoClient({
  view,
  reportBase,
  canEdit,
  canMessage,
  canApprove,
  canReview,
}: {
  view: SchoolPromoView;
  reportBase: string;
  canEdit: boolean;
  canMessage: boolean;
  canApprove: boolean;
  /** Подтвердить или отклонить привязку по переписке — администратор и владелец. */
  canReview: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      router.refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не получилось");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const st = view.stats;
  return (
    <>
      <header className="border-border flex-none border-b px-7 py-[18px] max-md:px-5">
        <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">{view.name}</h1>
        <p className="text-text-muted mt-1.5 text-xs">
          {formatMoney(view.priceTotal)} вместо {formatMoney(view.priceRegular)}
          {view.ageMin != null || view.ageMax != null ? ` · ${view.ageMin ?? "…"}–${view.ageMax ?? "…"} лет` : ""} · до{" "}
          {dateFmt.format(new Date(`${view.endsOn}T12:00:00Z`))} · бонус школе {formatMoney(view.bonusAmount)} за пришедшего
          {view.open ? "" : " · акция закончилась или выключена — новых участников не добавить"}
        </p>
      </header>

      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <div className="flex max-w-[1040px] flex-col gap-5">
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
            <Tile label="Переходов по ссылке" value={formatNumber(st.linkClicks)} hint="с начала акции" />
            <Tile label="По ссылке" value={formatNumber(st.byMarker)} hint="написали «школьный ресурс»" />
            <Tile label="Подтверждено по переписке" value={formatNumber(st.byEvidence)} hint={st.manual ? `и вручную ${formatNumber(st.manual)}` : undefined} />
            <Tile label="На проверке" value={formatNumber(st.inReview)} accent={st.inReview > 0} />
            <Tile label="Повторные пациенты" value={formatNumber(st.returning)} hint="привязаны, бонуса нет" />
            <Tile label="Записались" value={formatNumber(st.booked)} />
            <Tile label="Пришли" value={formatNumber(st.arrived)} />
            <Tile label="Бонус начислен" value={formatMoney(st.bonusEarned)} hint={`за ${formatNumber(st.bonusCount)}`} />
            <Tile label="Снято бонусов" value={formatNumber(st.reversed)} />
            <Tile label="Визиты акции без источника" value={formatNumber(st.visitsWithoutSource)} hint="пришли или записаны, а привязки нет" />
          </div>

          {error ? <p className="text-accent-text text-sm">{error}</p> : null}

          <Warnings view={view} />
          {view.review.length > 0 ? <Review view={view} canReview={canReview} busy={busy} run={run} /> : null}
          <ShareLink view={view} />
          <Participants view={view} canMessage={canMessage} busy={busy} run={run} />
          <Schools view={view} reportBase={reportBase} canEdit={canEdit} run={run} />

          <details className="border-border bg-surface rounded-xl border">
            <summary className="cursor-pointer px-5 py-3 text-sm font-medium">Условия, состав и услуги акции</summary>
            <div className="border-border-soft border-t">
              <Settings view={view} canEdit={canEdit} onSaved={() => router.refresh()} run={run} />
            </div>
          </details>

          <details className="border-border bg-surface rounded-xl border">
            <summary className="cursor-pointer px-5 py-3 text-sm font-medium">
              Что агент отвечает об акции{view.agentEnabled ? "" : " — агент сейчас об акции не знает"}
            </summary>
            <div className="border-border-soft border-t p-3">
              <PromoKnowledge promoId={view.id} entries={view.knowledge} canEdit={canEdit} canApprove={canApprove} />
            </div>
          </details>
        </div>
      </div>
    </>
  );
}

function Tile({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: boolean }) {
  return (
    <div className={`bg-surface rounded-xl border px-4 py-3 ${accent ? "border-accent" : "border-border"}`}>
      <p className="text-text-subtle text-2xs">{label}</p>
      <p className={`num mt-1 text-lg font-medium ${accent ? "text-accent-text" : ""}`}>{value}</p>
      {hint ? <p className="text-text-subtle mt-0.5 text-2xs">{hint}</p> : null}
    </div>
  );
}

// ─────────────────────────────────────────────── предупреждения

function Warnings({ view }: { view: SchoolPromoView }) {
  if (view.serviceWarnings.length === 0 && view.mismatches.length === 0) return null;
  const MISMATCH: Record<SchoolPromoView["mismatches"][number]["kind"], string> = {
    "booked-missing": "уведомление YCLIENTS о записи на услугу акции есть, а записи у нас нет",
    "cancelled-alive": "уведомление YCLIENTS об отмене есть, а запись у нас не отменена",
    "no-card": "уведомление о записи на акцию в переписке без карточки пациента",
  };
  return (
    <section className="border-border bg-surface rounded-xl border px-5 py-3">
      <h2 className="text-sm font-medium">Проверьте</h2>
      <ul className="mt-1.5 flex flex-col gap-1 text-sm">
        {view.serviceWarnings.map((w) => (
          <li key={w} className="text-accent-text">
            {w}
          </li>
        ))}
        {view.mismatches.map((m) => (
          <li key={m.messageId}>
            <span className="text-accent-text">Расхождение:</span> {m.patientName ?? "пациент без карточки"}, приём{" "}
            {whenFmt.format(new Date(m.at))} — {MISMATCH[m.kind]}.{" "}
            <Link href={`/inbox?d=${encodeURIComponent(m.conversationId)}`} className="text-accent-text text-xs hover:underline">
              переписка
            </Link>
          </li>
        ))}
      </ul>
      {view.mismatches.length > 0 ? (
        <p className="text-text-subtle mt-1.5 text-xs">
          Из уведомлений ничего не создаётся: источник — YCLIENTS. Обычно расхождение уходит со следующей выгрузкой; осталось — проверьте запись.
        </p>
      ) : null}
    </section>
  );
}

// ─────────────────────────────────────────────── на проверке

function Review({
  view,
  canReview,
  busy,
  run,
}: {
  view: SchoolPromoView;
  canReview: boolean;
  busy: boolean;
  run: (a: () => Promise<unknown>) => Promise<boolean>;
}) {
  return (
    <section className="border-accent bg-surface rounded-xl border">
      <header className="border-border-soft border-b px-5 py-3">
        <h2 className="text-sm font-medium">На проверке: {formatNumber(view.review.length)}</h2>
        <p className="text-text-subtle mt-0.5 text-xs">
          Разбор переписки нашёл, откуда пациент: написал про нашу школу без ссылки — или пришёл по ссылке, но назвал другую школу. Бонус — только после «Подтвердить». Отклонённое — окончательно.
        </p>
      </header>
      <ul>
        {view.review.map((r) => (
          <li key={r.attributionId} className="border-border-soft flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-5 py-3 first:border-t-0">
            <div className="min-w-[240px] flex-1">
              <Link href={`/patients/${r.patientId}`} className="text-sm hover:underline">
                {r.patientName}
              </Link>
              {r.returning ? <span className="text-text-subtle text-xs"> · повторный пациент — бонуса не будет</span> : null}
              <p className="text-text-subtle mt-0.5 text-xs">
                {r.confidence === "MARKER"
                  ? "Пришла по ссылке школы, но в переписке назвала другой источник. «Подтвердить» — оставить за школой, «Отклонить» — не от школы."
                  : "Ссылки не было, но в переписке написала про школу. «Подтвердить» — привязать к школе."}
              </p>
              {r.evidenceQuote ? <p className="text-text mt-0.5 text-sm">«{r.evidenceQuote}»</p> : null}
              {r.conversationId ? (
                <Link href={`/inbox?d=${encodeURIComponent(r.conversationId)}`} className="text-accent-text text-xs hover:underline">
                  открыть переписку
                </Link>
              ) : null}
            </div>
            {canReview ? (
              <span className="flex items-center gap-2 text-xs">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => reviewPromoAttribution(r.attributionId, "confirm"))}
                  className="bg-accent text-accent-contrast rounded-md px-2.5 py-1 font-medium disabled:opacity-45"
                >
                  Подтвердить
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => reviewPromoAttribution(r.attributionId, "reject"))}
                  className="border-border hover:bg-hover rounded-md border px-2.5 py-1"
                >
                  Отклонить
                </button>
              </span>
            ) : (
              <span className="text-text-subtle text-xs">решает администратор или владелец</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ─────────────────────────────────────────────── ссылка и QR

function readableLink(link: string): string {
  try {
    return decodeURIComponent(link);
  } catch {
    return link;
  }
}

const noSubscribe = () => () => {};

function ShareLink({ view }: { view: SchoolPromoView }) {
  /**
   * Короткая ссылка — адрес самой платформы + `/children`: на листовке и в чате
   * школы её можно напечатать и набрать руками, а куда она ведёт, решают
   * настройки ниже (app/children/route.ts). Адрес берём из открытой вкладки:
   * платформа работает на домене клиники, и ссылка совпадёт с ним сама.
   */
  // Адрес вкладки известен только в браузере; на сервере — null, без расхождения при гидрации.
  const origin = useSyncExternalStore(noSubscribe, () => window.location.origin, () => null);
  const shortLink = origin ? `${origin}/children` : null;
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!view.waLink || !shortLink) return;
    let alive = true;
    // QR — на короткую ссылку: меньше точек, легче считать с распечатки.
    QRCode.toDataURL(shortLink, { margin: 1, width: 512, errorCorrectionLevel: "M" })
      .then((url) => alive && setQr(url))
      .catch(() => alive && setQr(null));
    return () => {
      alive = false;
    };
  }, [view.waLink, shortLink]);

  return (
    <Group
      title="Ссылка для школы"
      hint="Мама открывает ссылку — WhatsApp клиники с готовым текстом «Хочу записать ребёнка на школьный ресурс». Сообщение с этими словами в первые сутки привязывает нового пациента к школе само."
    >
      {view.waLink ? (
        <div className="flex flex-wrap items-start gap-4">
          {qr ? (
            // Картинка собрана в браузере из ссылки — внешних сервисов нет.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qr} alt="QR-код короткой ссылки на WhatsApp клиники" width={128} height={128} className="border-border rounded-md border" />
          ) : null}
          <div className="flex min-w-[240px] flex-1 flex-col gap-2">
            <code className="bg-raise border-border block rounded-md border px-3 py-2 text-sm break-all">{shortLink ?? "…/children"}</code>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <button
                type="button"
                disabled={!shortLink}
                onClick={async () => {
                  if (!shortLink) return;
                  await navigator.clipboard.writeText(shortLink).catch(() => {});
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                className="border-border hover:bg-hover rounded-md border px-3 py-1.5 disabled:opacity-45"
              >
                {copied ? "Скопировано" : "Скопировать"}
              </button>
              {qr ? (
                <a href={qr} download="whatsapp-shkolny-resurs-qr.png" className="border-border hover:bg-hover rounded-md border px-3 py-1.5">
                  Скачать QR
                </a>
              ) : null}
              {shortLink ? (
                <a href={shortLink} target="_blank" rel="noreferrer" className="text-accent-text text-xs hover:underline">
                  проверить
                </a>
              ) : null}
            </div>
            <details className="text-text-subtle text-xs">
              <summary className="cursor-pointer">куда ведёт</summary>
              <code className="mt-1 block break-all">{readableLink(view.waLink)}</code>
              {view.open ? null : <p className="mt-1">Акция не идёт — ссылка открывает WhatsApp клиники без готового текста.</p>}
            </details>
          </div>
        </div>
      ) : (
        <p className="text-text-muted text-sm">Укажите номер WhatsApp клиники в условиях акции — без него ссылку не собрать.</p>
      )}
    </Group>
  );
}

// ─────────────────────────────────────────────── участники

function Participants({
  view,
  canMessage,
  busy,
  run,
}: {
  view: SchoolPromoView;
  canMessage: boolean;
  busy: boolean;
  run: (a: () => Promise<unknown>) => Promise<boolean>;
}) {
  const activeSchools = view.schools.filter((s) => s.isActive);
  return (
    <section className="border-border bg-surface rounded-xl border">
      <header className="border-border-soft border-b px-5 py-3">
        <h2 className="text-sm font-medium">Участники</h2>
        <p className="text-text-subtle mt-0.5 text-xs">
          Бонус школе начисляется сам, когда в YCLIENTS отмечен визит по услуге акции, — один на участника, сколько бы специалистов
          ни было в визите. Или кнопкой «Прошёл». Ручные отметки автоматика не трогает.
        </p>
      </header>
      {canMessage && view.open ? <AddParticipant schools={activeSchools} run={run} /> : null}
      {view.participants.length === 0 ? (
        <p className="text-text-muted px-5 py-4 text-sm">Участников пока нет.</p>
      ) : (
        <ul>
          {view.participants.map((p) => (
            <li key={p.attributionId} className="border-border-soft flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-5 py-3">
              <div className="min-w-[220px] flex-1">
                <Link href={`/patients/${p.patientId}`} className="text-sm hover:underline">
                  {p.patientName}
                </Link>
                {p.phoneTail ? <span className="text-text-subtle num text-xs"> · …{p.phoneTail}</span> : null}
                {p.isExtraChild ? <span className="text-text-muted text-xs"> · ребёнок {p.childNo}</span> : null}
                {p.note ? <span className="text-text-muted text-sm"> · {p.note}</span> : null}
                <p className="text-text-subtle text-2xs">
                  <span className="bg-raise border-border mr-1 rounded border px-1 py-px">{HOW[p.confidence]}</span>
                  {p.createdBy ?? "сотрудник"} · {shortFmt.format(new Date(p.attributedAt))}
                </p>
              </div>
              <select
                aria-label={`Школа: ${p.patientName}`}
                value={p.schoolId ?? ""}
                disabled={!canMessage || busy}
                onChange={(e) => void run(() => setPromoParticipantSchool(p.attributionId, e.target.value || null))}
                className="border-border-input bg-surface max-w-[220px] rounded-md border px-2 py-1 text-xs"
              >
                <option value="">без школы</option>
                {view.schools.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <span className={`min-w-[150px] text-xs ${STATUS[p.status].tone}`}>
                {STATUS[p.status].label}
                {p.bonus?.status === "EARNED" ? ` · ${formatMoney(p.bonus.amount)}${p.bonus.manual ? " (вручную)" : ""}` : ""}
                {p.bonus?.status === "REVERSED" && p.bonus.reason ? `: ${p.bonus.reason}` : ""}
              </span>
              {canMessage ? (
                <span className="flex flex-wrap items-center gap-2 text-xs">
                  {p.status === "waiting" || p.status === "no_school" || p.status === "reversed" || p.status === "returning" ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(() => markPromoDone(p.attributionId))}
                      className="bg-accent text-accent-contrast rounded-md px-2.5 py-1 font-medium disabled:opacity-45"
                    >
                      {p.schoolId ? "Прошёл — начислить бонус" : "Прошёл"}
                    </button>
                  ) : null}
                  {p.status === "done" ? (
                    <button type="button" disabled={busy} onClick={() => void run(() => unmarkPromoDone(p.attributionId))} className="text-text-muted hover:text-text">
                      Отменить «прошёл»
                    </button>
                  ) : null}
                  {p.status === "bonus" ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        const reason = prompt("Почему снимаем бонус? (необязательно)");
                        if (reason !== null) void run(() => revokePromoBonus(p.attributionId, reason));
                      }}
                      className="text-text-muted hover:text-text"
                    >
                      Снять бонус
                    </button>
                  ) : null}
                  {view.open && p.childNo === 1 ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        const name = prompt("Имя второго ребёнка (необязательно)");
                        if (name === null) return;
                        void run(async () => {
                          const r = await attachPatientToSchool({
                            patientId: p.patientId,
                            schoolId: p.schoolId,
                            conversationId: p.conversationId,
                            childName: name.trim() || null,
                            extraChild: true,
                          });
                          if (!r.ok) throw new Error("reason" in r ? r.reason : "Не получилось добавить второго ребёнка");
                        });
                      }}
                      className="text-text-muted hover:text-text"
                    >
                      Добавить второго ребёнка
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (confirm(`Снять привязку ${p.patientName}? Начисленный бонус будет снят.`)) void run(() => detachPatientFromSchool(p.attributionId));
                    }}
                    className="text-text-muted hover:text-text"
                  >
                    Снять привязку
                  </button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AddParticipant({
  schools,
  run,
}: {
  schools: SchoolPromoView["schools"];
  run: (a: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<{ id: string; name: string; phoneTail: string | null }[]>([]);
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const [schoolId, setSchoolId] = useState(schools[0]?.id ?? "");
  const [childName, setChildName] = useState("");
  const [family, setFamily] = useState<{ who: string; school: string }[] | null>(null);
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    // Ищем, пока человек печатает; короткий запрос — пустой список, без обращения к серверу.
    const short = picked !== null || q.trim().length < 2;
    const t = setTimeout(() => {
      if (short) setFound([]);
      else void findPatientsForPromo(q).then(setFound).catch(() => setFound([]));
    }, short ? 0 : 250);
    return () => clearTimeout(t);
  }, [q, picked]);

  async function add(extraChild: boolean) {
    if (!picked) return;
    setReason(null);
    let result: Awaited<ReturnType<typeof attachPatientToSchool>> | null = null;
    const ok = await run(async () => {
      result = await attachPatientToSchool({
        patientId: picked.id,
        schoolId: schoolId || null,
        conversationId: null,
        childName: childName.trim() || null,
        extraChild,
      });
    });
    const r = result as Awaited<ReturnType<typeof attachPatientToSchool>> | null;
    if (!ok || !r) return;
    if (r.ok) {
      setPicked(null);
      setQ("");
      setChildName("");
      setFamily(null);
    } else if ("family" in r) setFamily(r.family);
    else setReason(r.reason);
  }

  return (
    <div className="border-border-soft flex flex-col gap-2 border-b px-5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        {picked ? (
          <span className="bg-raise border-border inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-sm">
            {picked.name}
            <button type="button" aria-label="Выбрать другого" onClick={() => setPicked(null)} className="text-text-muted hover:text-text">
              ×
            </button>
          </span>
        ) : (
          <div className="relative min-w-[240px] flex-1">
            <TextInput placeholder="Добавить пациента — имя или телефон" aria-label="Найти пациента" value={q} onChange={(e) => setQ(e.target.value)} />
            {found.length > 0 ? (
              <ul className="border-border bg-surface absolute z-10 mt-1 w-full rounded-md border shadow-none">
                {found.map((f) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setPicked({ id: f.id, name: f.name });
                        setFound([]);
                      }}
                      className="hover:bg-hover w-full px-3 py-2 text-left text-sm"
                    >
                      {f.name}
                      {f.phoneTail ? <span className="text-text-subtle num text-xs"> · …{f.phoneTail}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
        <select aria-label="Школа" value={schoolId} onChange={(e) => setSchoolId(e.target.value)} className="border-border-input bg-surface rounded-md border px-2 py-2 text-sm">
          <option value="">без школы</option>
          {schools.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <div className="w-48 max-md:w-full">
          <TextInput placeholder="имя ребёнка" aria-label="Имя ребёнка" value={childName} onChange={(e) => setChildName(e.target.value)} />
        </div>
        <button
          type="button"
          disabled={!picked}
          onClick={() => void add(false)}
          className="bg-accent text-accent-contrast rounded-md px-3 py-2 text-sm font-medium disabled:opacity-45"
        >
          Добавить
        </button>
      </div>
      {family ? (
        <div className="border-border bg-raise flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs">
          <span>
            У этой семьи уже есть участник ({family.map((f) => `${f.who} — ${f.school}`).join("; ")}). Добавить второго ребёнка отдельно?
          </span>
          <button type="button" onClick={() => void add(true)} className="border-border hover:bg-hover rounded-md border px-2.5 py-1">
            Да, второй ребёнок
          </button>
          <button type="button" onClick={() => setFamily(null)} className="text-text-muted hover:text-text">
            Нет
          </button>
        </div>
      ) : null}
      {reason ? <p className="text-accent-text text-xs">{reason}</p> : null}
    </div>
  );
}

// ─────────────────────────────────────────────── школа

function Schools({
  view,
  reportBase,
  canEdit,
  run,
}: {
  view: SchoolPromoView;
  reportBase: string;
  canEdit: boolean;
  run: (a: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <Group
      title="Школа"
      hint="Отчёт для школы — только итоги: сколько привязано, пришло и сумма бонуса. Без имён и дат. Синонимы — как ещё родители называют школу в переписке."
    >
      {view.schools.length === 0 ? <p className="text-text-muted text-sm">Школы пока нет — добавьте её ниже.</p> : null}
      <ul className="flex flex-col">
        {view.schools.map((s) => {
          const url = `${reportBase}/partner/${s.reportToken}`;
          return (
            <li key={s.id} className="border-border-soft flex flex-col gap-2 border-b py-2.5 last:border-b-0">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="min-w-[200px] flex-1 text-sm">
                  {s.name}
                  {s.contactName ? <span className="text-text-subtle text-xs"> · {s.contactName}</span> : null}
                  {!s.isActive ? <span className="text-text-subtle text-xs"> · выключена</span> : null}
                </span>
                <span className="num text-text-muted text-xs">
                  участников {formatNumber(s.totals.attributed)} · пришли {formatNumber(s.totals.arrived)} · {formatMoney(s.totals.bonusEarned)}
                </span>
                <button
                  type="button"
                  className="text-accent-text text-xs hover:underline"
                  onClick={async () => {
                    await navigator.clipboard.writeText(url).catch(() => {});
                    setCopied(s.id);
                    setTimeout(() => setCopied(null), 1500);
                  }}
                >
                  {copied === s.id ? "Скопировано" : "Отчёт для школы"}
                </button>
                {canEdit ? (
                  <span className="flex items-center gap-3 text-xs">
                    <button
                      type="button"
                      className="text-text-muted hover:text-text"
                      onClick={() => {
                        if (confirm("Старая ссылка на отчёт перестанет открываться. Выдать новую?")) void run(() => rotateSchoolToken(s.id));
                      }}
                    >
                      Новая ссылка
                    </button>
                    <Toggle
                      checked={s.isActive}
                      label={`Школа ${s.name} участвует`}
                      onChange={(v) =>
                        void run(() =>
                          saveSchool({ id: s.id, promoId: view.id, name: s.name, contactName: s.contactName, contactPhone: s.contactPhone, isActive: v }),
                        )
                      }
                    />
                  </span>
                ) : null}
              </div>
              {canEdit ? <AliasEditor school={s} promoId={view.id} run={run} /> : s.aliases.length ? <p className="text-text-subtle text-xs">синонимы: {s.aliases.join(", ")}</p> : null}
            </li>
          );
        })}
      </ul>
      {canEdit ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await run(() => saveSchool({ promoId: view.id, name, contactName: contact || null, contactPhone: null, isActive: true }));
            if (ok) {
              setName("");
              setContact("");
            }
          }}
        >
          <div className="min-w-[200px] flex-1">
            <TextInput placeholder="Название школы" aria-label="Название школы" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="w-52 max-md:w-full">
            <TextInput placeholder="Контакт (необязательно)" aria-label="Контакт" value={contact} onChange={(e) => setContact(e.target.value)} />
          </div>
          <button type="submit" disabled={name.trim().length < 2} className="border-border hover:bg-hover rounded-md border px-3 py-2 text-sm disabled:opacity-45">
            Добавить школу
          </button>
        </form>
      ) : null}
    </Group>
  );
}

function AliasEditor({
  school,
  promoId,
  run,
}: {
  school: SchoolPromoView["schools"][number];
  promoId: string;
  run: (a: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [text, setText] = useState(school.aliases.join(", "));
  const list = text
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length >= 2);
  const changed = list.join("|") !== school.aliases.join("|");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-[240px] flex-1">
        <TextInput
          aria-label={`Синонимы школы ${school.name}`}
          placeholder="Синонимы через запятую: «Росток», «подготовка у Мадины»"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <button
        type="button"
        disabled={!changed}
        onClick={() =>
          void run(() =>
            saveSchool({
              id: school.id,
              promoId,
              name: school.name,
              contactName: school.contactName,
              contactPhone: school.contactPhone,
              isActive: school.isActive,
              aliases: list,
            }),
          )
        }
        className="border-border hover:bg-hover rounded-md border px-3 py-1.5 text-xs disabled:opacity-45"
      >
        Сохранить синонимы
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────── условия, состав, услуги

function Settings({
  view,
  canEdit,
  onSaved,
  run,
}: {
  view: SchoolPromoView;
  canEdit: boolean;
  onSaved: () => void;
  run: (a: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [form, setForm] = useState({
    name: view.name,
    description: view.description ?? "",
    priceTotal: view.priceTotal,
    priceRegular: view.priceRegular,
    ageMin: view.ageMin,
    ageMax: view.ageMax,
    startsOn: view.startsOn,
    endsOn: view.endsOn,
    bonusAmount: view.bonusAmount,
    isActive: view.isActive,
    agentEnabled: view.agentEnabled,
    aiReviewEnabled: view.aiReviewEnabled,
    waMarker: view.waMarker,
    waPhone: view.waPhone ?? "",
    serviceIds: view.promoServices.filter((s) => s.how === "chosen").map((s) => s.yclientsServiceId),
    serviceKeywords: view.serviceKeywords.join(", "),
    excludedServiceIds: view.promoServices.filter((s) => s.how === "excluded").map((s) => s.yclientsServiceId),
    items: view.items.map((i) => ({ title: i.title, price: i.price, yclientsServiceId: i.yclientsServiceId })),
  });
  const [pick, setPick] = useState("");
  const [aiNote, setAiNote] = useState<string | null>(null);
  const patch = (next: Partial<typeof form>) => setForm((f) => ({ ...f, ...next }));
  const num = (v: string) => (v.trim() === "" ? 0 : Number(v.replace(",", ".")));
  const intOrNull = (v: string) => (v.trim() === "" ? null : Number.parseInt(v, 10));
  const sum = form.items.reduce((t, i) => t + (Number.isFinite(i.price) ? i.price : 0), 0);
  const titleOf = (id: number) => view.services.find((s) => s.yclientsServiceId === id)?.title ?? view.promoServices.find((s) => s.yclientsServiceId === id)?.title ?? String(id);

  const servicesList = (
    <ul className="mt-2 flex flex-col gap-1 text-sm">
      {view.promoServices.length === 0 ? <li className="text-accent-text">Ни одной услуги акции — визиты не засчитаются никому.</li> : null}
      {view.promoServices.map((s) => (
        <li key={`${s.how}-${s.yclientsServiceId}`} className="flex flex-wrap items-center gap-x-3">
          <span className={s.how === "excluded" ? "text-text-subtle line-through" : ""}>
            {s.title} <span className="text-text-subtle num text-xs">· {formatMoney(s.price)} · {s.yclientsServiceId}</span>
          </span>
          <span className="text-text-subtle text-xs">
            {s.how === "chosen" ? "выбрана" : s.how === "keyword" ? "поймана по названию" : "исключена вручную"}
          </span>
        </li>
      ))}
    </ul>
  );

  if (!canEdit) {
    return (
      <div className="flex flex-col gap-3 px-5 py-4 text-sm">
        <div>
          <p className="font-medium">Услуги YCLIENTS, визиты по которым засчитываются</p>
          {servicesList}
        </div>
        <ul className="flex flex-col gap-1">
          {view.items.map((i) => (
            <li key={i.title}>
              {i.title} — {formatMoney(i.price)}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const keywordRows = view.promoServices.filter((s) => s.how === "keyword" || s.how === "excluded");
  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <div>
        <p className="text-sm font-medium">Услуги YCLIENTS, визиты по которым засчитываются</p>
        <p className="text-text-subtle mt-0.5 text-xs">
          Всё, что начинается со слов ниже, ловится само — и «Школьный ресурс 6+», и его части у разных специалистов. Лишнее исключите,
          недостающее выберите из списка. Визит из нескольких записей — один визит.
        </p>
        {servicesList}
        <div className="mt-3 flex flex-col gap-2">
          <Field label="Ловить по началу названия" hint="через запятую" htmlFor="sp-kw">
            <TextInput id="sp-kw" value={form.serviceKeywords} onChange={(e) => patch({ serviceKeywords: e.target.value })} />
          </Field>
          {keywordRows.length ? (
            <ul className="flex flex-col gap-1 text-xs">
              {keywordRows.map((s) => {
                const off = form.excludedServiceIds.includes(s.yclientsServiceId);
                return (
                  <li key={s.yclientsServiceId}>
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={!off}
                        onChange={(e) =>
                          patch({
                            excludedServiceIds: e.target.checked
                              ? form.excludedServiceIds.filter((x) => x !== s.yclientsServiceId)
                              : [...form.excludedServiceIds, s.yclientsServiceId],
                          })
                        }
                      />
                      {s.title} · {s.yclientsServiceId} — {off ? "исключена" : "в акции"}
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <div>
            <p className="text-xs">Выбраны вручную:</p>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {form.serviceIds.map((id) => (
                <li key={id} className="bg-raise border-border inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs">
                  {titleOf(id)}
                  <button
                    type="button"
                    aria-label={`Убрать ${titleOf(id)}`}
                    onClick={() => patch({ serviceIds: form.serviceIds.filter((x) => x !== id) })}
                    className="text-text-muted hover:text-text"
                  >
                    ×
                  </button>
                </li>
              ))}
              {form.serviceIds.length === 0 ? <li className="text-text-subtle text-xs">нет</li> : null}
            </ul>
            <select
              aria-label="Добавить услугу YCLIENTS"
              value={pick}
              onChange={(e) => {
                const v = Number(e.target.value);
                setPick("");
                if (v && !form.serviceIds.includes(v)) patch({ serviceIds: [...form.serviceIds, v] });
              }}
              className="border-border-input bg-surface mt-1.5 max-w-[420px] rounded-md border px-2 py-2 text-xs"
            >
              <option value="">+ выбрать услугу из YCLIENTS</option>
              {view.services
                .filter((s) => !form.serviceIds.includes(s.yclientsServiceId))
                .map((s) => (
                  <option key={s.yclientsServiceId} value={s.yclientsServiceId}>
                    {s.title} — {formatMoney(s.price)}
                  </option>
                ))}
            </select>
          </div>
        </div>
      </div>

      <div>
        <p className="text-sm font-medium">Состав для пациента и агента</p>
        <p className="text-text-subtle mt-0.5 text-xs">Что входит и сколько стоит по отдельности. На засчитывание визитов не влияет — для этого список услуг выше.</p>
        <ul className="mt-2 flex flex-col gap-2">
          {form.items.map((it, idx) => (
            <li key={idx} className="flex flex-wrap items-center gap-2">
              <div className="min-w-[220px] flex-1">
                <TextInput
                  aria-label="Позиция"
                  value={it.title}
                  onChange={(e) => patch({ items: form.items.map((x, j) => (j === idx ? { ...x, title: e.target.value } : x)) })}
                />
              </div>
              <div className="w-24">
                <TextInput
                  aria-label="Цена"
                  inputMode="numeric"
                  value={String(it.price)}
                  onChange={(e) => patch({ items: form.items.map((x, j) => (j === idx ? { ...x, price: num(e.target.value) } : x)) })}
                />
              </div>
              <button
                type="button"
                aria-label="Убрать позицию"
                onClick={() => patch({ items: form.items.filter((_, j) => j !== idx) })}
                className="text-text-muted hover:text-text px-1"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex items-center gap-4 text-xs">
          <button
            type="button"
            onClick={() => patch({ items: [...form.items, { title: "", price: 0, yclientsServiceId: null }] })}
            className="text-accent-text hover:underline"
          >
            + Позиция
          </button>
          <span className="text-text-muted num">По отдельности выходит {formatMoney(sum)}</span>
        </div>
      </div>

      <Field label="Название" htmlFor="sp-name">
        <TextInput id="sp-name" value={form.name} onChange={(e) => patch({ name: e.target.value })} />
      </Field>
      <Field label="Описание" htmlFor="sp-desc">
        <Textarea id="sp-desc" rows={2} value={form.description} onChange={(e) => patch({ description: e.target.value })} />
      </Field>
      <Field label="Цена акции и по отдельности, ₽">
        <div className="flex items-center gap-2">
          <TextInput aria-label="Цена акции" inputMode="numeric" value={String(form.priceTotal)} onChange={(e) => patch({ priceTotal: num(e.target.value) })} />
          <TextInput aria-label="По отдельности" inputMode="numeric" value={String(form.priceRegular)} onChange={(e) => patch({ priceRegular: num(e.target.value) })} />
        </div>
      </Field>
      <Field label="Возраст, лет">
        <div className="flex items-center gap-2">
          <TextInput aria-label="от" inputMode="numeric" value={form.ageMin ?? ""} onChange={(e) => patch({ ageMin: intOrNull(e.target.value) })} />
          <TextInput aria-label="до" inputMode="numeric" value={form.ageMax ?? ""} onChange={(e) => patch({ ageMax: intOrNull(e.target.value) })} />
        </div>
      </Field>
      <Field label="Действует">
        <div className="flex items-center gap-2">
          <TextInput aria-label="с" type="date" value={form.startsOn} onChange={(e) => patch({ startsOn: e.target.value })} />
          <TextInput aria-label="по" type="date" value={form.endsOn} onChange={(e) => patch({ endsOn: e.target.value })} />
        </div>
      </Field>
      <Field label="Бонус школе, ₽" hint="за пришедшего нового пациента" htmlFor="sp-bonus">
        <TextInput id="sp-bonus" inputMode="numeric" value={String(form.bonusAmount)} onChange={(e) => patch({ bonusAmount: num(e.target.value) })} />
      </Field>
      <Field label="Метка — слова в сообщении" hint="по умолчанию «школьный ресурс», в любом падеже; первые сутки обращения" htmlFor="sp-marker">
        <TextInput id="sp-marker" value={form.waMarker} onChange={(e) => patch({ waMarker: e.target.value })} />
      </Field>
      <Field label="WhatsApp клиники для ссылки" htmlFor="sp-wa">
        <TextInput id="sp-wa" inputMode="tel" value={form.waPhone} onChange={(e) => patch({ waPhone: e.target.value })} />
      </Field>
      <Field label="Акция идёт">
        <Toggle checked={form.isActive} onChange={(v) => patch({ isActive: v })} label="Акция идёт" />
      </Field>
      <Field label="Агент рассказывает об акции" hint="только тому, кто спросил сам, и только записями ниже">
        <Toggle checked={form.agentEnabled} onChange={(v) => patch({ agentEnabled: v })} label="Агент рассказывает об акции" />
      </Field>
      <Field
        label="Разбор переписки"
        hint="ночью: без ссылки — ищет упоминание школы; по ссылке — упоминание другой школы. Найденное — на проверку, не в бонус"
      >
        <div className="flex flex-wrap items-center gap-3">
          <Toggle checked={form.aiReviewEnabled} onChange={(v) => patch({ aiReviewEnabled: v })} label="Разбор переписки" />
          <button
            type="button"
            disabled={!view.aiReviewEnabled}
            onClick={() =>
              void run(async () => {
                const r = await runPromoAiReview();
                setAiNote(r);
              })
            }
            className="border-border hover:bg-hover rounded-md border px-3 py-1.5 text-xs disabled:opacity-45"
          >
            Проверить сейчас
          </button>
          {aiNote ? <span className="text-text-muted text-xs">{aiNote}</span> : null}
        </div>
      </Field>
      <SaveBar
        error={
          form.endsOn < form.startsOn
            ? "Конец акции раньше начала"
            : form.items.some((i) => !i.title.trim())
              ? "У позиции нет названия"
              : form.waMarker.trim().length < 2
                ? "Метка — хотя бы два знака"
                : null
        }
        onSave={async () => {
          await saveSchoolPromo({
            ...form,
            description: form.description || null,
            waPhone: form.waPhone.trim() || null,
            serviceKeywords: form.serviceKeywords
              .split(",")
              .map((k) => k.trim())
              .filter((k) => k.length >= 3),
          });
          onSaved();
        }}
      />
    </div>
  );
}
