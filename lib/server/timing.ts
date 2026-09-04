/**
 * Замер серверной сборки страницы.
 *
 * Кабинет владельца собирает четыре независимых отчёта. Когда он грузится
 * долго, по экрану не понять, какой из них тянет, — а гадать по коду мы
 * договорились не гадать. Одна строка в журнале отвечает за секунду:
 * `pm2 logs clinic | grep "кабинет владельца"`.
 *
 * Замер живёт отдельным модулем, а не в самой странице: часы — побочный
 * эффект, и внутри рендера компонента им не место.
 */

export interface Timed<T> {
  name: string;
  ms: number;
  value: T;
}

export async function timed<T>(name: string, run: () => Promise<T>): Promise<Timed<T>> {
  const at = Date.now();
  const value = await run();
  return { name, ms: Date.now() - at, value };
}

/** Одна строка в журнал: сколько заняло целое и каждая часть. */
export function logTimings(label: string, parts: Timed<unknown>[]): void {
  const total = parts.reduce((max, p) => Math.max(max, p.ms), 0);
  console.log(
    `[${label}] дольше всех ${total} мс · ` + parts.map((p) => `${p.name} ${p.ms}`).join(" · ") + " мс",
  );
}
