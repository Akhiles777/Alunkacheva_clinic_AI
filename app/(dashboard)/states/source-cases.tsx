"use client";

import { SourcePicker } from "../_components/visit-source";
import { GapsBlock, type GapsData } from "../settings/assistant/gaps-block";

/**
 * Витрина источника визита — отдельным клиентским компонентом.
 *
 * Экран состояний серверный: он читает базу. Обработчик `onPick` из него в
 * клиентский `SourcePicker` не проходит — React отвечает «Event handlers cannot
 * be passed to Client Component props», и рендер обрывается. Ломался при этом
 * не один блок, а ВЕСЬ экран: в браузере оставались меню и пустое поле, а
 * граничные состояния — то, ради чего экран существует, — не показывались
 * вовсе. Заглушка живёт здесь, где обработчик разрешён.
 */
export function SourceCases() {
  return (
    <div className="border-border bg-surface flex max-w-[560px] flex-col gap-3 rounded-xl border p-5">
      <SourcePicker
        state={{ code: "instagram", title: "Instagram", confidence: "MANUAL" }}
        onPick={() => {}}
      />
      <SourcePicker
        state={{ code: "whatsapp", title: "WhatsApp", confidence: "DERIVED" }}
        onPick={() => {}}
      />
      <SourcePicker state={{ code: null, title: null, confidence: "UNKNOWN" }} onPick={() => {}} />
      {/* Длинное название источника не должно ломать строку визита. */}
      <SourcePicker
        state={{
          code: "referral",
          title: "Рекомендация коллеги из соседней клиники",
          confidence: "MANUAL",
        }}
        onPick={() => {}}
      />
      {/* Только чтение: чужой день, отметки там не ставят. */}
      <SourcePicker
        state={{ code: "phone", title: "Звонок", confidence: "MANUAL" }}
        readOnly
        onPick={() => {}}
      />
    </div>
  );
}

/**
 * Пробелы в справочнике — та же причина, что и у витрины выше: кнопка
 * «Создать черновик» требует обработчика, а обработчик из серверного экрана
 * не проходит.
 */
export function GapsCase({ data }: { data: GapsData }) {
  return (
    <div className="max-w-[820px]">
      <GapsBlock data={data} onDraft={() => {}} />
    </div>
  );
}
