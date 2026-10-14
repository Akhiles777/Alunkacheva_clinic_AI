"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  Field,
  Group,
  SaveBar,
  TextInput,
  Textarea,
  Toggle,
} from "../../settings/_components/ui";
import { formatMoney, formatNumber } from "@/lib/format";
import type { PromoDetail } from "@/lib/server/promos";
import { saveSchool, savePromo } from "../actions";

export interface PromoView {
  id: string | null;
  name: string;
  description: string | null;
  priceTotal: number;
  priceRegular: number;
  ageMin: number | null;
  ageMax: number | null;
  serviceIds: number[];
  startsOn: string;
  endsOn: string;
  bonusAmount: number;
  isActive: boolean;
  agentEnabled: boolean;
}

type Choice = { yclientsServiceId: number; title: string; price: number };

const intOrNull = (v: string) =>
  v.trim() === "" ? null : Number.parseInt(v, 10);
const numOr0 = (v: string) =>
  v.trim() === "" ? 0 : Number(v.replace(",", "."));

export function PromoClient({
  initial,
  detail,
  choices,
  canEdit,
}: {
  initial: PromoView;
  detail: PromoDetail | null;
  choices: Choice[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [form, setForm] = useState(initial);
  const [query, setQuery] = useState("");
  const patch = (next: Partial<PromoView>) =>
    setForm((f) => ({ ...f, ...next }));

  const selected = new Set(form.serviceIds);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q
      ? choices.filter((c) => c.title.toLowerCase().includes(q))
      : choices;
    // Выбранные всегда сверху: их не должно быть видно только при поиске.
    return [...rows].sort(
      (a, b) =>
        Number(selected.has(b.yclientsServiceId)) -
        Number(selected.has(a.yclientsServiceId)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choices, query, form.serviceIds]);

  const error =
    form.name.trim().length < 2
      ? "У акции должно быть название"
      : form.endsOn < form.startsOn
        ? "Конец акции раньше начала"
        : null;

  return (
    <>
      <header className="border-border flex-none border-b px-7 py-[18px] max-md:px-5">
        <Link
          href="/promos"
          className="text-text-muted hover:text-text text-xs"
        >
          ← Акции
        </Link>
        <h1 className="mt-1 text-xl leading-none font-medium tracking-[-0.015em]">
          {initial.id ? initial.name : "Новая акция"}
        </h1>
        {detail ? (
          <p className="text-text-muted mt-1.5 text-xs">
            {detail.open
              ? "идёт — привязки заводятся"
              : "закончилась или выключена — новые привязки не заводятся, прежние работают"}
          </p>
        ) : null}
      </header>

      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <div className="flex max-w-[960px] flex-col gap-5">
          {detail ? (
            <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
              <Tile
                label="Привязано"
                value={formatNumber(detail.totals.attributed)}
              />
              <Tile
                label="Пришли"
                value={formatNumber(detail.totals.arrived)}
              />
              <Tile
                label="Бонус школам"
                value={formatMoney(detail.totals.bonusEarned)}
              />
              <Tile
                label="Снято бонусов"
                value={formatNumber(detail.totals.reversed)}
                hint={
                  detail.totals.reversed
                    ? `на ${formatMoney(detail.totals.bonusReversed)}`
                    : "визиты не отменяли"
                }
              />
            </div>
          ) : null}

          {detail ? (
            <Schools
              promoId={detail.id}
              schools={detail.schools}
              canEdit={canEdit}
              onChange={() => router.refresh()}
            />
          ) : null}

          {canEdit ? (
            <Group
              title="Условия акции"
              hint="Цены — справочные: что стоит в записи, решает YCLIENTS."
            >
              <Field label="Название" htmlFor="promo-name">
                <TextInput
                  id="promo-name"
                  value={form.name}
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </Field>
              <Field
                label="Описание"
                hint="для экрана"
                htmlFor="promo-desc"
              >
                <Textarea
                  id="promo-desc"
                  rows={3}
                  value={form.description ?? ""}
                  onChange={(e) => patch({ description: e.target.value })}
                />
              </Field>
              <Field label="Цена акции, ₽" htmlFor="promo-total">
                <TextInput
                  id="promo-total"
                  inputMode="numeric"
                  value={String(form.priceTotal)}
                  onChange={(e) =>
                    patch({ priceTotal: numOr0(e.target.value) })
                  }
                />
              </Field>
              <Field label="По отдельности, ₽" htmlFor="promo-regular">
                <TextInput
                  id="promo-regular"
                  inputMode="numeric"
                  value={String(form.priceRegular)}
                  onChange={(e) =>
                    patch({ priceRegular: numOr0(e.target.value) })
                  }
                />
              </Field>
              <Field label="Возраст, лет" hint="от и до включительно">
                <div className="flex items-center gap-2">
                  <TextInput
                    aria-label="возраст от"
                    inputMode="numeric"
                    value={form.ageMin ?? ""}
                    onChange={(e) =>
                      patch({ ageMin: intOrNull(e.target.value) })
                    }
                  />
                  <span className="text-text-muted">—</span>
                  <TextInput
                    aria-label="возраст до"
                    inputMode="numeric"
                    value={form.ageMax ?? ""}
                    onChange={(e) =>
                      patch({ ageMax: intOrNull(e.target.value) })
                    }
                  />
                </div>
              </Field>
              <Field label="Действует" hint="по дням клиники, включительно">
                <div className="flex items-center gap-2">
                  <TextInput
                    aria-label="с"
                    type="date"
                    value={form.startsOn}
                    onChange={(e) => patch({ startsOn: e.target.value })}
                  />
                  <span className="text-text-muted">—</span>
                  <TextInput
                    aria-label="по"
                    type="date"
                    value={form.endsOn}
                    onChange={(e) => patch({ endsOn: e.target.value })}
                  />
                </div>
              </Field>
              <Field
                label="Бонус школе, ₽"
                hint="за пришедшего; в привязке замораживается"
                htmlFor="promo-bonus"
              >
                <TextInput
                  id="promo-bonus"
                  inputMode="numeric"
                  value={String(form.bonusAmount)}
                  onChange={(e) =>
                    patch({ bonusAmount: numOr0(e.target.value) })
                  }
                />
              </Field>
              <Field label="Акция включена">
                <Toggle
                  checked={form.isActive}
                  onChange={(v) => patch({ isActive: v })}
                  label="Акция включена"
                />
              </Field>
              <Field
                label="Агент знает об акции"
                hint="подключается следующим этапом — пока агент об акции не знает, что бы здесь ни стояло"
              >
                <Toggle
                  checked={form.agentEnabled}
                  onChange={(v) => patch({ agentEnabled: v })}
                  label="Агент знает об акции"
                />
              </Field>

              <div className="border-border-soft border-t pt-4">
                <p className="text-sm">
                  Услуги YCLIENTS, которые засчитываются
                </p>
                <p className="text-text-subtle mt-0.5 text-2xs">
                  Пришёл на любую из них после привязки — школе начисляется
                  бонус, один раз. Check-up может быть одной услугой или
                  четырьмя — отметьте все.
                </p>
                {form.serviceIds.length === 0 ? (
                  <p className="text-accent-text mt-2 text-xs">
                    Услуги не выбраны — пока не выбраны, бонус не начислится
                    никому.
                  </p>
                ) : null}
                {detail?.unknownServiceIds.length ? (
                  <p className="text-accent-text mt-2 text-xs">
                    Номеров нет в справочнике услуг:{" "}
                    {detail.unknownServiceIds.join(", ")} — визиты по ним не
                    сопоставить.
                  </p>
                ) : null}
                <div className="mt-3" />
                <TextInput
                  placeholder="Найти услугу"
                  aria-label="Найти услугу"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <ul className="border-border mt-2 max-h-72 overflow-auto rounded-md border">
                  {visible.map((c) => (
                    <li
                      key={c.yclientsServiceId}
                      className="border-border-soft border-b last:border-b-0"
                    >
                      <label className="hover:bg-hover flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                        <input
                          type="checkbox"
                          checked={selected.has(c.yclientsServiceId)}
                          onChange={(e) =>
                            patch({
                              serviceIds: e.target.checked
                                ? [...form.serviceIds, c.yclientsServiceId]
                                : form.serviceIds.filter(
                                    (n) => n !== c.yclientsServiceId,
                                  ),
                            })
                          }
                        />
                        <span className="min-w-0 flex-1">{c.title}</span>
                        <span className="num text-text-muted text-xs">
                          {formatMoney(c.price)}
                        </span>
                      </label>
                    </li>
                  ))}
                  {visible.length === 0 ? (
                    <li className="text-text-muted px-3 py-2 text-sm">
                      Ничего не нашлось
                    </li>
                  ) : null}
                </ul>
              </div>

              <SaveBar
                error={error}
                onSave={async () => {
                  const { id } = await savePromo({
                    ...form,
                    id: form.id ?? undefined,
                  });
                  if (!form.id) router.replace(`/promos/${id}`);
                  else router.refresh();
                }}
              />
            </Group>
          ) : detail ? (
            <Group title="Условия акции">
              <p className="text-sm">
                {formatMoney(detail.priceTotal)} вместо{" "}
                {formatMoney(detail.priceRegular)} · бонус школе{" "}
                {formatMoney(detail.bonusAmount)}
                {detail.ageMin != null || detail.ageMax != null
                  ? ` · ${detail.ageMin ?? "…"}–${detail.ageMax ?? "…"} лет`
                  : ""}
              </p>
              {detail.services.length ? (
                <p className="text-text-muted text-xs">
                  Засчитываются:{" "}
                  {detail.services.map((s) => s.title).join(", ")}
                </p>
              ) : null}
            </Group>
          ) : null}
        </div>
      </div>
    </>
  );
}

function Tile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="border-border bg-surface rounded-xl border px-4 py-3">
      <p className="text-text-subtle text-2xs">{label}</p>
      <p className="num mt-1 text-lg font-medium">{value}</p>
      {hint ? <p className="text-text-subtle mt-0.5 text-2xs">{hint}</p> : null}
    </div>
  );
}

function Schools({
  promoId,
  schools,
  canEdit,
  onChange,
}: {
  promoId: string;
  schools: PromoDetail["schools"];
  canEdit: boolean;
  onChange: () => void;
}) {
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Group
      title="Школы-партнёры"
      hint="У каждой школы своя ссылка на отчёт — только итоги, без имён."
    >
      {schools.length === 0 ? (
        <p className="text-text-muted text-sm">Школ пока нет.</p>
      ) : (
        <ul className="flex flex-col">
          {schools.map((s) => (
            <li
              key={s.id}
              className="border-border-soft border-b last:border-b-0"
            >
              <Link
                href={`/schools/${s.id}`}
                className="hover:bg-hover -mx-2 flex flex-wrap items-center gap-x-5 gap-y-1 rounded-md px-2 py-2.5"
              >
                <span className="min-w-[180px] flex-1 text-sm">
                  {s.name}
                  {!s.isActive ? (
                    <span className="text-text-subtle"> · выключена</span>
                  ) : null}
                </span>
                <span className="num text-text-muted text-xs">
                  привязано {formatNumber(s.totals.attributed)}
                </span>
                <span className="num text-text-muted text-xs">
                  пришли {formatNumber(s.totals.arrived)}
                </span>
                <span className="num text-xs">
                  {formatMoney(s.totals.bonusEarned)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <form
          className="border-border-soft flex flex-wrap items-end gap-2 border-t pt-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await saveSchool({
                promoId,
                name,
                contactName: contact || null,
                contactPhone: phone || null,
                isActive: true,
              });
              setName("");
              setContact("");
              setPhone("");
              onChange();
            } catch (err) {
              setError(
                err instanceof Error
                  ? err.message
                  : "Не удалось добавить школу",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="min-w-[200px] flex-1">
            <TextInput
              placeholder="Название школы"
              aria-label="Название школы"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="w-44 max-md:w-full">
            <TextInput
              placeholder="Контакт"
              aria-label="Контактное лицо"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
            />
          </div>
          <div className="w-40 max-md:w-full">
            <TextInput
              placeholder="Телефон"
              aria-label="Телефон контакта"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <button
            type="submit"
            disabled={busy || name.trim().length < 2}
            className="border-border hover:bg-hover rounded-md border px-3 py-2 text-sm disabled:opacity-45"
          >
            Добавить школу
          </button>
          {error ? (
            <p className="text-accent-text w-full text-xs">{error}</p>
          ) : null}
        </form>
      ) : null}
    </Group>
  );
}
