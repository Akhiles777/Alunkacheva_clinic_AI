/**
 * Клавиатура инбокса.
 *
 * Администратор работает быстро и весь день: рука, уходящая к мыши на каждый
 * следующий диалог, — это и есть разница в скорости с WhatsApp Web, из-за
 * которой он туда возвращается.
 *
 * Правила вынесены сюда и проверены тестами по одной причине: главная ошибка
 * горячих клавиш — срабатывать во время набора текста. «u» посреди слова,
 * переключившее диалог, стоит человеку набранного ответа и доверия ко всему
 * сочетанию клавиш разом. Поэтому решение о том, что делать с нажатием,
 * принимается в одном месте и проверяется, а не рассыпано по обработчикам.
 */

export type InboxAction =
  | "next"
  | "prev"
  | "nextWaiting"
  | "send"
  | "escape"
  | "help"
  | "reply"
  | null;

export interface KeyContext {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  /** Курсор стоит в поле ввода или в редактируемой области. */
  typing: boolean;
}

export function hotkeyAction(e: KeyContext): InboxAction {
  const mod = Boolean(e.metaKey || e.ctrlKey);

  /**
   * Пока человек печатает, работают только два сочетания: отправить и выйти.
   * Всё остальное — буквы его сообщения.
   */
  if (e.typing) {
    if (mod && e.key === "Enter") return "send";
    if (e.key === "Escape") return "escape";
    return null;
  }

  if (e.altKey) return null;
  if (mod && e.key === "Enter") return "send";
  // ⌘K и другие сочетания с модификатором принадлежат приложению целиком
  // (глобальный поиск), и перехватывать их здесь нельзя.
  if (mod) return null;

  switch (e.key) {
    case "ArrowDown":
    case "j":
      return "next";
    case "ArrowUp":
    case "k":
      return "prev";
    case "u":
      return "nextWaiting";
    case "r":
      return "reply";
    case "Escape":
      return "escape";
    case "?":
      return "help";
    default:
      return null;
  }
}

/** Шпаргалка по «?». Один список: он же показывается человеку. */
export const HOTKEYS: { keys: string; what: string }[] = [
  { keys: "↑ ↓ · j k", what: "предыдущий и следующий диалог" },
  { keys: "u", what: "следующий, кто ждёт ответа" },
  { keys: "r", what: "ответить — курсор в поле ввода" },
  { keys: "Enter", what: "отправить (Shift+Enter — новая строка)" },
  { keys: "⌘/Ctrl + Enter", what: "отправить, не убирая рук с текста" },
  { keys: "⌘/Ctrl + K", what: "поиск по пациентам и перепискам" },
  { keys: "Esc", what: "закрыть панель, вернуться к списку" },
  { keys: "?", what: "эта шпаргалка" },
];

/**
 * Следующий по кругу.
 *
 * По кругу — потому что список короткий, и упираться в его конец на каждом
 * проходе неудобно; из последнего диалога «вниз» ведёт к первому.
 */
export function step(ids: string[], current: string | null, delta: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const i = current ? ids.indexOf(current) : -1;
  if (i === -1) return delta === 1 ? ids[0] : ids[ids.length - 1];
  return ids[(i + delta + ids.length) % ids.length];
}

/**
 * Следующий, кто ждёт ответа, — начиная от текущего и дальше по кругу.
 *
 * Именно от текущего, а не с начала списка: иначе клавиша возвращала бы к
 * первому ждущему снова и снова, и обойти очередь было бы нельзя.
 */
export function nextWaiting(
  rows: { id: string; waiting: boolean }[],
  current: string | null,
): string | null {
  if (rows.length === 0) return null;
  const from = current ? rows.findIndex((r) => r.id === current) : -1;
  for (let n = 1; n <= rows.length; n++) {
    const row = rows[(from + n + rows.length) % rows.length];
    if (row.waiting) return row.id;
  }
  return null;
}
