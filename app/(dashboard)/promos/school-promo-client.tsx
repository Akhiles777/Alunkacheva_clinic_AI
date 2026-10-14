"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatMoney, formatNumber } from "@/lib/format";
import type { PromoParticipant, SchoolPromoView } from "@/lib/server/promos";
import { Field, Group, SaveBar, TextInput, Textarea, Toggle } from "../settings/_components/ui";
import { PromoKnowledge } from "./promo-knowledge";
import {
  attachPatientToSchool,
  detachPatientFromSchool,
  findPatientsForPromo,
  markPromoDone,
  revokePromoBonus,
  rotateSchoolToken,
  saveSchool,
  saveSchoolPromo,
  setPromoParticipantSchool,
  unmarkPromoDone,
} from "./actions";

const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });
const shortFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });

const STATUS: Record<PromoParticipant["status"], { label: string; tone: string }> = {
  waiting: { label: "ждём визита", tone: "text-text-muted" },
  done: { label: "прошёл", tone: "text-text" },
  bonus: { label: "прошёл · бонус начислен", tone: "text-text font-medium" },
  reversed: { label: "бонус снят", tone: "text-accent-text" },
  no_school: { label: "без школы — бонуса нет", tone: "text-text-subtle" },
};

export function SchoolPromoClient({
  view,
  reportBase,
  canEdit,
  canMessage,
  canApprove,
}: {
  view: SchoolPromoView;
  reportBase: string;
  canEdit: boolean;
  canMessage: boolean;
  canApprove: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const done = view.participants.filter((p) => p.status === "bonus" || p.status === "done").length;

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

  return (
    <>
      <header className="border-border flex-none border-b px-7 py-[18px] max-md:px-5">
        <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">{view.name}</h1>
        <p className="text-text-muted mt-1.5 text-xs">
          {formatMoney(view.priceTotal)} вместо {formatMoney(view.priceRegular)}
          {view.ageMin != null || view.ageMax != null ? ` · ${view.ageMin ?? "…"}–${view.ageMax ?? "…"} лет` : ""} · до{" "}
          {dateFmt.format(new Date(`${view.endsOn}T12:00:00Z`))} · бонус школе {formatMoney(view.bonusAmount)}
          {view.open ? "" : " · акция закончилась или выключена — новых участников не добавить"}
        </p>
      </header>

      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <div className="flex max-w-[1040px] flex-col gap-5">
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            <Tile label="Участников" value={formatNumber(view.participants.length)} />
            <Tile label="Прошли" value={formatNumber(done)} />
            <Tile label="Бонус школам" value={formatMoney(view.totals.bonusEarned)} />
            <Tile label="Снято бонусов" value={formatNumber(view.totals.reversed)} hint={view.totals.reversed ? `на ${formatMoney(view.totals.bonusReversed)}` : undefined} />
          </div>

          {error ? <p className="text-accent-text text-sm">{error}</p> : null}

          <Participants view={view} canMessage={canMessage} busy={busy} run={run} />
          <Schools view={view} reportBase={reportBase} canEdit={canEdit} run={run} />

          <details className="border-border bg-surface rounded-xl border">
            <summary className="cursor-pointer px-5 py-3 text-sm font-medium">Условия и состав акции</summary>
            <div className="border-border-soft border-t">
              <Settings view={view} canEdit={canEdit} onSaved={() => router.refresh()} />
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

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border-border bg-surface rounded-xl border px-4 py-3">
      <p className="text-text-subtle text-2xs">{label}</p>
      <p className="num mt-1 text-lg font-medium">{value}</p>
      {hint ? <p className="text-text-subtle mt-0.5 text-2xs">{hint}</p> : null}
    </div>
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
          Бонус школе начисляется сам, когда в YCLIENTS отмечен визит по услуге акции, — или кнопкой «Прошёл». Ручные отметки
          автоматика не трогает.
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
                {p.note ? <span className="text-text-muted text-sm"> · {p.note}</span> : null}
                <p className="text-text-subtle text-2xs">
                  {p.source === "AGENT" ? "добавил агент" : `добавил(а) ${p.createdBy ?? "сотрудник"}`} · {shortFmt.format(new Date(p.attributedAt))}
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
                  {p.status === "waiting" || p.status === "no_school" || p.status === "reversed" ? (
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
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (confirm(`Убрать ${p.patientName} из акции? Начисленный бонус будет снят.`)) void run(() => detachPatientFromSchool(p.attributionId));
                    }}
                    className="text-text-muted hover:text-text"
                  >
                    Убрать
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
  const [schoolId, setSchoolId] = useState("");
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

// ─────────────────────────────────────────────── школы

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
    <Group title="Школы-партнёры" hint="Ссылка для школы — только итоги: сколько привязано, пришло и сумма бонуса. Без имён и дат.">
      {view.schools.length === 0 ? <p className="text-text-muted text-sm">Школ пока нет.</p> : null}
      <ul className="flex flex-col">
        {view.schools.map((s) => {
          const url = `${reportBase}/partner/${s.reportToken}`;
          return (
            <li key={s.id} className="border-border-soft flex flex-wrap items-center gap-x-4 gap-y-1 border-b py-2.5 last:border-b-0">
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
                {copied === s.id ? "Скопировано" : "Ссылка для школы"}
              </button>
              {canEdit ? (
                <span className="flex items-center gap-3 text-xs">
                  <button
                    type="button"
                    className="text-text-muted hover:text-text"
                    onClick={() => {
                      if (confirm("Старая ссылка перестанет открываться. Выдать новую?")) void run(() => rotateSchoolToken(s.id));
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

// ─────────────────────────────────────────────── условия и состав

function Settings({ view, canEdit, onSaved }: { view: SchoolPromoView; canEdit: boolean; onSaved: () => void }) {
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
    items: view.items.map((i) => ({ title: i.title, price: i.price, yclientsServiceId: i.yclientsServiceId })),
  });
  const patch = (next: Partial<typeof form>) => setForm((f) => ({ ...f, ...next }));
  const num = (v: string) => (v.trim() === "" ? 0 : Number(v.replace(",", ".")));
  const intOrNull = (v: string) => (v.trim() === "" ? null : Number.parseInt(v, 10));
  const sum = form.items.reduce((t, i) => t + (Number.isFinite(i.price) ? i.price : 0), 0);

  if (!canEdit) {
    return (
      <ul className="flex flex-col gap-1 px-5 py-4 text-sm">
        {view.items.map((i) => (
          <li key={i.title}>
            {i.title} — {formatMoney(i.price)}
            <span className="text-text-subtle text-xs"> · {i.serviceTitle ? `в YCLIENTS: ${i.serviceTitle}` : "в YCLIENTS не связана"}</span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <div>
        <p className="text-sm font-medium">Состав</p>
        <p className="text-text-subtle mt-0.5 text-xs">
          Позиция, связанная со строкой прайса YCLIENTS, засчитывается сама, когда визит отмечен «пришёл». Не связанную — отмечайте
          «Прошёл» у участника.
        </p>
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
              <select
                aria-label="Строка YCLIENTS"
                value={it.yclientsServiceId ?? ""}
                onChange={(e) =>
                  patch({ items: form.items.map((x, j) => (j === idx ? { ...x, yclientsServiceId: e.target.value ? Number(e.target.value) : null } : x)) })
                }
                className="border-border-input bg-surface max-w-[300px] rounded-md border px-2 py-2 text-xs"
              >
                <option value="">не связана с YCLIENTS</option>
                {view.services.map((s) => (
                  <option key={s.yclientsServiceId} value={s.yclientsServiceId}>
                    {s.title} — {formatMoney(s.price)}
                  </option>
                ))}
              </select>
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
      <Field label="Бонус школе, ₽" hint="за пришедшего" htmlFor="sp-bonus">
        <TextInput id="sp-bonus" inputMode="numeric" value={String(form.bonusAmount)} onChange={(e) => patch({ bonusAmount: num(e.target.value) })} />
      </Field>
      <Field label="Акция идёт">
        <Toggle checked={form.isActive} onChange={(v) => patch({ isActive: v })} label="Акция идёт" />
      </Field>
      <Field label="Агент рассказывает об акции" hint="только тому, кто спросил сам, и только записями ниже">
        <Toggle checked={form.agentEnabled} onChange={(v) => patch({ agentEnabled: v })} label="Агент рассказывает об акции" />
      </Field>
      <SaveBar
        error={form.endsOn < form.startsOn ? "Конец акции раньше начала" : form.items.some((i) => !i.title.trim()) ? "У позиции нет названия" : null}
        onSave={async () => {
          await saveSchoolPromo({ ...form, description: form.description || null });
          onSaved();
        }}
      />
    </div>
  );
}
