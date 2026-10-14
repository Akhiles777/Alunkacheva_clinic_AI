"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { PatientPromoState } from "@/lib/server/promos";
import { attachPatientToSchool, detachPatientFromSchool, loadPatientPromos } from "../promos/actions";

const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });

/**
 * Привязка пациента к школе-партнёру — прямо в переписке, не уходя в раздел
 * акций (волна 2: посреди диалога никуда не уходим).
 *
 * Второй ребёнок той же семьи — только по явному согласию администратора:
 * система показывает, кто уже привязан, и спрашивает. Сама не добавляет.
 */
export function PromoBlock({ patientId, conversationId }: { patientId: string; conversationId: string }) {
  const [state, setState] = useState<PatientPromoState | null>(null);
  const reload = useCallback(() => {
    loadPatientPromos(patientId)
      .then(setState)
      // Нет права или сбой — блока просто нет; переписка работает как обычно.
      .catch(() => setState(null));
  }, [patientId]);
  useEffect(reload, [reload]);

  if (!state || state.promos.length === 0) return null;
  return (
    <div className="border-border-soft flex flex-col gap-1.5 border-b px-5 py-2 text-xs">
      {state.promos.map((p) => (
        <PromoRow key={p.id} promo={p} patientId={patientId} conversationId={conversationId} onChanged={reload} />
      ))}
    </div>
  );
}

function PromoRow({
  promo,
  patientId,
  conversationId,
  onChanged,
}: {
  promo: PatientPromoState["promos"][number];
  patientId: string;
  conversationId: string;
  onChanged: () => void;
}) {
  const has = promo.attributions.length > 0;
  const [open, setOpen] = useState(false);
  const [schoolId, setSchoolId] = useState("");
  const [childName, setChildName] = useState("");
  const [family, setFamily] = useState<{ who: string; school: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function attach(extraChild: boolean) {
    setBusy(true);
    setError(null);
    try {
      const r = await attachPatientToSchool({
        patientId,
        schoolId,
        conversationId,
        childName: childName.trim() || null,
        extraChild,
      });
      if (r.ok) {
        setFamily(null);
        setOpen(false);
        setChildName("");
        onChanged();
      } else if ("family" in r) {
        setFamily(r.family);
      } else {
        setError(r.reason);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не получилось привязать");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link href={`/promos/${promo.id}`} className="text-text-muted hover:text-text">
          {promo.name}
        </Link>
        {promo.attributions.map((a) => (
          <span key={a.id} className="bg-raise border-border inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5">
            <span>
              {a.schoolName}
              {a.note ? ` · ${a.note}` : ""}
            </span>
            <span className="text-text-subtle">
              {a.source === "AGENT" ? "агент" : (a.createdBy ?? "сотрудник")}, {dateFmt.format(new Date(a.attributedAt))} ·{" "}
              {a.bonus?.status === "EARNED"
                ? "пришёл, бонус начислен"
                : a.bonus?.status === "REVERSED"
                  ? `бонус снят: ${a.bonus.reverseReason ?? "без причины"}`
                  : "ждём визита"}
            </span>
            <button
              type="button"
              className="text-text-muted hover:text-text"
              aria-label={`Снять привязку к ${a.schoolName}`}
              onClick={async () => {
                if (!confirm("Снять привязку? Начисленный бонус будет снят с причиной.")) return;
                await detachPatientFromSchool(a.id).catch((e) => setError(e instanceof Error ? e.message : "Не получилось"));
                onChanged();
              }}
            >
              ×
            </button>
          </span>
        ))}
        {!has && !promo.open ? <span className="text-text-subtle">акция закончилась</span> : null}
        {promo.open && !open ? (
          <button type="button" onClick={() => setOpen(true)} className="text-accent-text hover:underline">
            {has ? "Ещё ребёнок" : "Привязать к школе"}
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Школа"
            value={schoolId}
            onChange={(e) => {
              setSchoolId(e.target.value);
              setFamily(null);
            }}
            className="border-border-input bg-surface rounded-md border px-2 py-1 text-xs"
          >
            <option value="">выберите школу</option>
            {promo.schools.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <input
            aria-label="Имя ребёнка"
            placeholder="имя ребёнка (необязательно)"
            value={childName}
            onChange={(e) => setChildName(e.target.value)}
            className="border-border-input bg-surface placeholder:text-text-subtle w-48 rounded-md border px-2 py-1 text-xs"
          />
          <button
            type="button"
            disabled={!schoolId || busy}
            onClick={() => attach(false)}
            className="bg-accent text-accent-contrast rounded-md px-2.5 py-1 font-medium disabled:opacity-45"
          >
            Привязать
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setFamily(null);
              setError(null);
            }}
            className="text-text-muted hover:text-text"
          >
            Отмена
          </button>
          {promo.schools.length === 0 ? (
            <span className="text-text-subtle">школ в акции пока нет — их заводят на экране акции</span>
          ) : null}
        </div>
      ) : null}

      {family ? (
        <div className="border-border bg-raise flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
          <span>
            У этой семьи уже есть привязка ({family.map((f) => `${f.who} — ${f.school}`).join("; ")}). Добавить второго
            ребёнка отдельно? Бонус за него начислится, когда он сам придёт на приём.
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => attach(true)}
            className="border-border hover:bg-hover rounded-md border px-2.5 py-1"
          >
            Да, это второй ребёнок
          </button>
          <button type="button" onClick={() => setFamily(null)} className="text-text-muted hover:text-text">
            Нет
          </button>
        </div>
      ) : null}
      {error ? <p className="text-accent-text">{error}</p> : null}
    </div>
  );
}
