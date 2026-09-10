"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HINTS } from "@/lib/help/topics";

/**
 * Знак вопроса рядом со сложным местом.
 *
 * Человек не читает документацию — обучение должно приходить в тот момент,
 * когда оно нужно, и ровно там, где возник вопрос. «Агент молчит до 23:08»
 * без объяснения выглядит как поломка, и администратор идёт спрашивать
 * голосом вместо того, чтобы работать.
 *
 * Текст берётся из `lib/help/topics` — того же места, откуда его берёт
 * справка. Две копии одного объяснения расходятся на второй правке, и человек
 * получает два разных ответа на один вопрос.
 *
 * Открывается и по наведению, и по нажатию: на телефоне наведения нет вовсе, а
 * подсказка нужна там не меньше.
 */
export function Hint({ id, className = "" }: { id: string; className?: string }) {
  /**
   * Наведение и нажатие — разные вещи и живут порознь.
   *
   * Пока они были одним состоянием, нажатие мышью закрывало подсказку сразу
   * после того, как её открыло наведение: человек кликал, чтобы прочитать
   * спокойно, и она исчезала. Нажатие теперь закрепляет — и держит, пока не
   * нажмут ещё раз; на телефоне, где наведения нет вовсе, это единственный
   * способ её открыть.
   */
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  /**
   * Подсказка рисуется поверх страницы, а не внутри своей строки.
   *
   * Знак вопроса стоит в строке с `truncate` — то есть в блоке с обрезанным
   * содержимым, — и всплывающее объяснение обрезалось вместе с ней: на
   * телефоне от него оставалась серая полоска в один пиксель. Поэтому
   * координаты считаем в момент открытия, а сам текст выносим в конец
   * документа. Заодно он не переворачивается за край экрана: сверху разворот
   * вниз, у краёв — прижатие к краю.
   */
  const [at, setAt] = useState<{ top: number; left: number; below: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  const open = (hover || pinned) && at !== null;
  const hint = HINTS[id];
  if (!hint) return null;

  const WIDTH = 260;

  function measure() {
    const box = btn.current?.getBoundingClientRect();
    if (!box) {
      setAt(null);
      return;
    }
    const width = Math.min(WIDTH, window.innerWidth - 24);
    const below = box.top < 160;
    setAt({
      below,
      top: below ? box.bottom + 8 : Math.max(8, box.top - 8),
      left: Math.min(Math.max(12, box.left + box.width / 2 - width / 2), window.innerWidth - width - 12),
    });
  }

  return (
    <span className={`relative inline-flex ${className}`}>
      <button
        type="button"
        aria-label="Что это значит"
        aria-expanded={open}
        ref={btn}
        onClick={(e) => {
          e.stopPropagation();
          measure();
          setPinned((v) => !v);
        }}
        onMouseEnter={() => {
          measure();
          setHover(true);
        }}
        onMouseLeave={() => setHover(false)}
        onFocus={() => {
          measure();
          setHover(true);
        }}
        onBlur={() => setHover(false)}
        className="border-border text-text-subtle hover:text-text hover:border-border-strong flex h-3.5 w-3.5 items-center justify-center rounded-full border text-[9px] leading-none"
      >
        ?
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <span
              role="tooltip"
              style={{
                top: at.top,
                left: at.left,
                width: Math.min(WIDTH, window.innerWidth - 24),
                // Над кнопкой текст поднимается на свою высоту сам; куда
                // разворачивать, решено при замере, а не во время отрисовки.
                transform: at.below ? undefined : "translateY(-100%)",
              }}
              className="border-border bg-surface text-text pointer-events-none fixed z-[80] rounded-md border p-2.5 text-xs leading-snug shadow-lg"
            >
              {hint.short}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
