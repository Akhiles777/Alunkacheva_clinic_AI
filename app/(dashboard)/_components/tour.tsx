"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Короткий тур по платформе при первом входе.
 *
 * Подсвечиваем НАСТОЯЩИЕ элементы на экране, а не картинки: человек должен
 * увидеть то место, куда ему потом идти, и запомнить его положение. Тур из
 * скриншотов запоминается как книжка — и не помогает в первый же рабочий день.
 *
 * Шаг, чей элемент на этом экране не найден, пропускается сам: администратор
 * запускает тур из справки, и заставлять его сначала перейти в «Диалоги» —
 * значит требовать знания, которого у него ещё нет.
 *
 * Отметка «видел» лежит в браузере: это удобство одного человека на одном
 * устройстве, а не сведение о клинике — в базе ему делать нечего.
 */

const SEEN_KEY = "clinic-tour-seen";

export interface TourStep {
  /** Что подсвечиваем: `[data-tour="…"]`. */
  target: string;
  title: string;
  text: string;
}

const STEPS: TourStep[] = [
  {
    target: "nav-inbox",
    title: "Диалоги — главный экран",
    text: "Переписка из WhatsApp и Instagram в одном окне. Число рядом — сколько человек ждёт ответа. Сверху списка тот, кто ждёт дольше всех.",
  },
  {
    target: "dialog-filters",
    title: "Кому отвечать",
    text: "«Нужен ответ» — те, кто ждёт. «Срочные» — где ассистент позвал человека. «Мои» — что вы взяли на себя.",
  },
  {
    target: "dialog-status",
    title: "«Ведёт агент» и «ведёт человек»",
    text: "Ассистент отвечает на справочные вопросы сам. Как только вы напишете вручную, разговор переходит к вам, и ассистент молчит четыре часа.",
  },
  {
    target: "call-admin",
    title: "Позвать администратора",
    text: "Отправляет коллегам уведомление, что пациент ждёт. Нужно, когда разговор не ваш или вы не успеваете.",
  },
  {
    target: "agent-off",
    title: "Выключить агента",
    text: "Навсегда для этого диалога, а не на время. Нужно там, где в пациентский чат пишут сотрудники клиники между собой.",
  },
  {
    target: "composer",
    title: "Ответ, файлы и шаблоны",
    text: "Enter отправляет, Shift+Enter — новая строка. «/» открывает шаблоны, скрепка — файл, микрофон — голосовое.",
  },
  {
    target: "patient-card",
    title: "Карточка пациента",
    text: "Справа — то, чего нет в телефоне: ближайшая запись, курс, неявки и служебные отметки. Отсюда же можно записать, не уходя из переписки.",
  },
];

export function Tour() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [box, setBox] = useState<DOMRect | null>(null);

  /**
   * Шагов всегда семь, и урезать их по тому, что видно сейчас, нельзя.
   *
   * Половина шагов живёт внутри переписки, а при первом входе не открыта ни
   * одна — тур из трёх шагов молча пропускал бы ровно то, ради чего он нужен:
   * поле ввода, кнопки и карточку пациента. Поэтому шаг, чей элемент ещё не
   * появился, не пропускается, а ЖДЁТ и просит открыть переписку. Человек
   * делает это сам — и заодно учится тому самому действию.
   */
  const steps = STEPS;

  const start = useCallback(() => {
    setStep(0);
    setOpen(true);
  }, []);

  useEffect(() => {
    function onStart() {
      start();
    }
    window.addEventListener("start-tour", onStart);
    return () => window.removeEventListener("start-tour", onStart);
  }, [start]);

  /**
   * Первый вход. Ждём, пока экран отрисуется: подсвечивать нечего, пока
   * список диалогов ещё грузится.
   */
  /** Запуск из справки: она уводит сюда адресом `/inbox?tour=1`. */
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!new URLSearchParams(window.location.search).get("tour")) return;
    window.history.replaceState(null, "", window.location.pathname);
    const t = setTimeout(start, 900);
    return () => clearTimeout(t);
  }, [start]);

  useEffect(() => {
    let seen = true;
    try {
      seen = localStorage.getItem(SEEN_KEY) === "1";
    } catch {
      // Приватное окно или запрет на хранение — тур просто не показываем сам.
    }
    if (seen) return;
    const t = setTimeout(start, 1500);
    return () => clearTimeout(t);
  }, [start]);

  const current = steps[step];

  useEffect(() => {
    if (!open || !current) return;
    let scrolled = false;
    /**
     * Ищем элемент постоянно, а не один раз: пока идёт шаг, человек может
     * открыть переписку — и подсветка обязана появиться сама, без «нажмите
     * ещё раз».
     */
    const measure = () => {
      const el = document.querySelector(`[data-tour="${current.target}"]`);
      if (!el) {
        setBox(null);
        return;
      }
      if (!scrolled) {
        scrolled = true;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      setBox(el.getBoundingClientRect());
    };
    measure();
    const timer = setInterval(measure, 400);
    window.addEventListener("resize", measure);
    return () => {
      clearInterval(timer);
      window.removeEventListener("resize", measure);
    };
  }, [open, current]);

  function finish() {
    setOpen(false);
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      // Не сохранилось — тур покажется ещё раз. Это лучше, чем упасть.
    }
  }

  if (!open || !current) return null;

  const pad = 6;
  const top = box ? Math.max(8, box.top - pad) : 0;
  const left = box ? Math.max(8, box.left - pad) : 0;
  const width = box ? box.width + pad * 2 : 0;
  const height = box ? box.height + pad * 2 : 0;

  /** Карточку ставим под элементом, а если он внизу экрана — над ним. */
  const below = box ? box.bottom + 12 : 0;
  const cardTop = box && box.bottom > window.innerHeight - 220 ? Math.max(8, box.top - 200) : below;

  return (
    /**
     * Тур ничего не перехватывает.
     *
     * Затемнение во весь экран ловило нажатия — и шаг «откройте любую
     * переписку» становился невыполнимым: человек кликал по списку, а попадал
     * в подложку. Тур учит действием, значит действовать во время тура надо
     * позволять. Ловит нажатия только сама карточка.
     */
    <div
      className="pointer-events-none fixed inset-0 z-[70]"
      role="dialog"
      aria-modal="false"
      aria-label="Знакомство с платформой"
    >
      <div className="overlay-scrim absolute inset-0 opacity-70" aria-hidden />
      {box ? (
        <div
          aria-hidden
          className="border-accent pointer-events-none absolute rounded-lg border-2"
          style={{ top, left, width, height }}
        />
      ) : null}

      <div
        className={`border-border bg-surface pointer-events-auto absolute w-[320px] max-w-[calc(100vw-24px)] rounded-xl border p-4 shadow-lg ${
          box ? "" : "left-1/2 top-1/3 -translate-x-1/2"
        }`}
        style={
          box
            ? { top: cardTop, left: Math.min(Math.max(8, box.left), window.innerWidth - 340) }
            : undefined
        }
      >
        <div className="text-text-subtle mb-1 text-2xs">
          Шаг {step + 1} из {steps.length}
        </div>
        <h2 className="text-md mb-1 font-medium">{current.title}</h2>
        <p className="text-text-muted text-sm leading-snug">{current.text}</p>
        {!box ? (
          <p className="text-accent-text mt-2 text-xs leading-snug">
            Откройте любую переписку слева — покажу это место в ней.
          </p>
        ) : null}
        <div className="mt-3 flex items-center gap-2">
          {step > 0 ? (
            <button
              type="button"
              onClick={() => setStep((i) => i - 1)}
              className="border-border text-text-muted hover:bg-hover rounded-md border px-2.5 py-1 text-xs"
            >
              Назад
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => (step + 1 < steps.length ? setStep((i) => i + 1) : finish())}
            className="bg-accent text-accent-contrast rounded-md px-3 py-1.5 text-xs font-medium"
          >
            {step + 1 < steps.length ? "Дальше" : "Понятно"}
          </button>
          <button
            type="button"
            onClick={finish}
            className="text-text-subtle hover:text-text ml-auto text-xs"
          >
            Пропустить
          </button>
        </div>
      </div>
    </div>
  );
}
