"use client";

import { useEffect } from "react";

/**
 * Высота рабочей области на телефоне, когда открыта клавиатура.
 *
 * Ничего не рисует. Жалоба звучала так: «в диалогах при нажатии поля снизу
 * выходит пустое пространство».
 *
 * Причина. Оболочка приложения занимает `100dvh` — высоту окна. Экранная
 * клавиатура окно НЕ уменьшает: она накрывает его сверху, и `dvh` остаётся
 * прежним. Нижние 250–300 точек раскладки оказываются под клавиатурой, а то,
 * что видно над ней, выглядит как экран с пустотой внизу. Сюда же добавлялся
 * запас `pb-16` под плавающие кнопки: на телефоне с клавиатурой он давал ещё
 * 64 точки пустоты ровно под полем ввода.
 *
 * Настоящий размер видимой области знает только `visualViewport` — им и
 * пользуемся. Он же позволяет отличить «клавиатура открыта» от «адресная
 * строка спряталась»: первое забирает сотни точек, второе десятки.
 *
 * Десктоп не трогаем вовсе: там `visualViewport` совпадает с окном, и правила
 * в CSS ограничены узкими экранами.
 */

/**
 * Насколько должна «пропасть» высота, чтобы считать это клавиатурой.
 *
 * Адресная строка Safari забирает около 60 точек при прокрутке — принять это
 * за клавиатуру значит дёргать раскладку на каждом движении пальца.
 */
const KEYBOARD_MIN_PX = 120;

export function ViewportFit() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const root = document.documentElement;
    let frame = 0;

    const apply = () => {
      frame = 0;
      const height = Math.round(vv.height);
      root.style.setProperty("--app-h", `${height}px`);
      /**
       * Где видимая область начинается.
       *
       * Safari на iPhone при фокусе поля не только открывает клавиатуру, но и
       * ПРОКРУЧИВАЕТ страницу вверх, чтобы поле оказалось на виду. Оболочка
       * при этом оставалась на месте: верх переписки уезжал под часы, а под
       * полем ввода открывалась пустота — «нажимаешь на поле, и тебя
       * сбрасывает вниз». Высоты для этого мало, нужна ещё и точка отсчёта.
       */
      root.style.setProperty("--app-top", `${Math.round(vv.offsetTop)}px`);
      const hidden = Math.round(window.innerHeight - height);
      if (hidden >= KEYBOARD_MIN_PX) root.setAttribute("data-kb", "open");
      else root.removeAttribute("data-kb");
    };

    /**
     * События идут пачками, пока клавиатура выезжает. Пересчитываем раз на
     * кадр: иначе раскладка пересобирается десятки раз за полсекунды, и на
     * недорогом телефоне это видно как рывок.
     */
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(apply);
    };

    apply();
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      root.style.removeProperty("--app-h");
      root.style.removeProperty("--app-top");
      root.removeAttribute("data-kb");
    };
  }, []);

  return null;
}
