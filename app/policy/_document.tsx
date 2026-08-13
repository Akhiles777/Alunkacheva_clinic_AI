import Link from "next/link";
import type { LegalDocument } from "@/lib/legal/documents";

/**
 * Показ юридического документа.
 *
 * Текст выводится как есть, абзацами. Разметку не выдумываем: подлинник —
 * документ, подписанный клиникой, и вольный пересказ его вида здесь означал бы
 * расхождение с тем, что подписано.
 */
export function LegalPage({ doc, other }: { doc: LegalDocument; other: { href: string; title: string } }) {
  // Пустые строки разделяют абзацы; несколько подряд схлопываем.
  const blocks = doc.body.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);

  return (
    <article>
      <h1 className="text-text text-xl font-semibold leading-snug">{doc.title}</h1>
      <p className="text-text-subtle mt-1 text-xs">Редакция от {doc.revision}</p>

      <div className="mt-6 flex flex-col gap-3">
        {blocks.map((block, i) => (
          <p key={i} className="text-text text-sm leading-relaxed whitespace-pre-line break-words">
            {block}
          </p>
        ))}
      </div>

      <div className="border-border mt-10 border-t pt-5">
        <Link href={other.href} className="text-accent-text text-sm hover:underline">
          {other.title}
        </Link>
      </div>
    </article>
  );
}
