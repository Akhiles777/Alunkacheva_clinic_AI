import type { AttentionItem, TodayInquiry } from "@/app/_data/today";

const KIND_LABEL: Record<AttentionItem["kind"], string> = {
  escalation: "Агент позвал",
  unanswered: "Ждёт ответа",
  stalled_course: "Курсы",
  unconfirmed: "Подтверждение",
};

/** Очередь дел. Срочное отличается плотностью текста и меткой, не цветом. */
export function AttentionList({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) {
    return <p className="text-text-muted text-sm">Пусто: ни эскалаций, ни диалогов без ответа.</p>;
  }
  return (
    <ul className="border-border bg-surface divide-border-soft divide-y overflow-hidden rounded-xl border">
      {items.map((item) => (
        <li key={item.id} className="hover:bg-hover px-4 py-3">
          <div className="flex items-baseline gap-3">
            <span
              className={`text-2xs ${item.urgent ? "text-accent-text font-medium" : "text-text-subtle"}`}
            >
              {KIND_LABEL[item.kind]}
            </span>
            <span className="num text-text-subtle ml-auto text-2xs">{item.waiting}</span>
          </div>
          <p className={`mt-1.5 text-sm leading-snug ${item.urgent ? "font-medium" : ""}`}>
            {item.title}
          </p>
          <p className="text-text-muted mt-0.5 text-xs leading-snug">{item.detail}</p>
        </li>
      ))}
    </ul>
  );
}

const CHANNEL_LABEL: Record<TodayInquiry["channel"], string> = {
  instagram: "Instagram",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
};

export function InquiryList({ items }: { items: TodayInquiry[] }) {
  if (items.length === 0) {
    return <p className="text-text-muted text-sm">Сегодня ещё не писали.</p>;
  }
  return (
    <ul className="border-border bg-surface divide-border-soft divide-y overflow-hidden rounded-xl border">
      {items.map((item) => (
        <li key={item.id} className="hover:bg-hover px-4 py-3">
          <div className="flex items-baseline gap-2">
            <p className="truncate text-sm font-medium">{item.name}</p>
            {item.isNewPatient ? (
              <span className="text-accent-text flex-none text-2xs font-medium">новый</span>
            ) : null}
            <span className="num text-text-subtle ml-auto flex-none text-2xs">{item.at}</span>
          </div>
          <p className="text-text-muted mt-1 truncate text-xs leading-snug">
            {CHANNEL_LABEL[item.channel]} · {item.preview}
          </p>
        </li>
      ))}
    </ul>
  );
}
