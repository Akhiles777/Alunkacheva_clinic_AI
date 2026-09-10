/**
 * Шаблоны сообщений WhatsApp.
 *
 * Вне 24-часового окна пациенту можно написать только заранее согласованным
 * шаблоном — это правило провайдера, а не наше. Шаблон содержит переменные в
 * двойных фигурных скобках: «Здравствуйте, {{name}}! Напоминаем о визите
 * {{date}} в {{time}}».
 *
 * Подстановка живёт здесь, отдельно от экранов, потому что ошибиться в ней
 * дорого: раньше подстановки не было вовсе, и кнопка шаблона отправляла
 * пациенту текст как есть — «Здравствуйте, {{name}}!». Один такой ответ
 * дороже десяти неотправленных: он показывает, что клиника пишет роботом и не
 * перечитывает.
 */

/** Имена переменных, которые встречаются в шаблоне. Порядок — как в тексте. */
export function templateVariables(body: string): string[] {
  return [...new Set([...body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))];
}

export type FillResult =
  | { ok: true; text: string }
  /** Чего не хватило: пациенту такой шаблон не отправляем вовсе. */
  | { ok: false; missing: string[] };

/**
 * Подставить значения.
 *
 * Пустая строка — это тоже «нечем заполнить»: «Напоминаем о визите  в » ничем
 * не лучше «{{date}}». Незаполненную переменную возвращаем списком, а не
 * молча оставляем в тексте.
 */
export function fillTemplate(body: string, values: Record<string, string | null | undefined>): FillResult {
  const missing = templateVariables(body).filter((name) => !values[name]?.trim());
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, text: body.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key]!.trim()) };
}

/** Понятная строка об отсутствующих значениях — её видит администратор. */
export const VARIABLE_LABEL: Record<string, string> = {
  name: "имя пациента",
  date: "дата ближайшей записи",
  time: "время ближайшей записи",
  service: "услуга ближайшей записи",
  staff: "специалист ближайшей записи",
  clinic: "название клиники",
};

export function missingLabel(missing: string[]): string {
  return missing.map((v) => VARIABLE_LABEL[v] ?? `{{${v}}}`).join(", ");
}

/**
 * Код шаблона: по нему его знает провайдер.
 *
 * Латиница и подчёркивания — так требует Meta, и так же выглядит код у
 * Green API. Из названия делаем сами, чтобы администратор не придумывал.
 */
export function codeFromTitle(title: string, taken: string[] = []): string {
  const translit: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
    й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
    у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
    э: "e", ю: "yu", я: "ya",
  };
  const base =
    [...title.toLowerCase()]
      .map((ch) => translit[ch] ?? (/[a-z0-9]/.test(ch) ? ch : " "))
      .join("")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 40) || "template";

  if (!taken.includes(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const next = `${base}_${i}`;
    if (!taken.includes(next)) return next;
  }
  return `${base}_${Date.now()}`;
}

/**
 * Сколько дней молчания делают шаблон кандидатом на удаление.
 *
 * Живёт здесь, а не в серверном модуле: число показывается на экране
 * настроек, а тянуть ради него в браузер модуль с Prisma нельзя. Удаляем не
 * мы: текст согласован с провайдером, и восстановить его — новая заявка и
 * новое ожидание. Система предлагает, решает человек.
 */
export const TEMPLATE_STALE_DAYS = 90;
