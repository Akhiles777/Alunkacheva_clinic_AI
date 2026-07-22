import type { ReactNode } from "react";

/**
 * Секция панели. Не карточка: фона у секции нет, от соседей её отделяет паз —
 * волосяная линия. Данные внутри лежат во вставках (bg-inset). См. DESIGN.md §4.
 */
export function Section({
  title,
  hint,
  children,
  className = "",
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <header className="border-groove flex items-baseline justify-between gap-3 border-b px-4 py-2">
        <h2 className="legend">{title}</h2>
        {hint ? <p className="legend tracking-[0.06em] normal-case">{hint}</p> : null}
      </header>
      <div className="px-4 py-3.5">{children}</div>
    </section>
  );
}

/** Утопленная вставка с данными. Разница светлоты + волосяная линия паза. */
export function Inset({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`bg-inset border-groove border ${className}`}>{children}</div>
  );
}
