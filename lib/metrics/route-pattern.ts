/**
 * Адрес экрана → его образец, а не конкретная строка.
 *
 * «/patients/cmtv9sg2r0000ze8o2pmmv9t6» в журнале бесполезно дважды: считать
 * по нему нельзя (у каждого пациента свой адрес, и статистика рассыпается на
 * тысячу строк по одной), а идентификатор пациента и так лежит в отдельном
 * поле. Поэтому в журнал идёт образец — «/patients/[id]», — а сам
 * идентификатор отдельно.
 *
 * Заодно это граница по §7: параметры запроса отбрасываются целиком. В них
 * живут идентификаторы пациентов и диалогов, а иногда и поисковые строки —
 * то, что сотрудник набирал руками, в журнал попадать не должно.
 */

/** Экраны, у которых есть подстраница с идентификатором. */
const WITH_ID = ["/patients", "/settings/staff"];

/** Как называется экран по-русски: журнал читают глазами, а не грепом. */
export const SCREEN_LABEL: Record<string, string> = {
  "/": "Сегодня",
  "/inbox": "Диалоги",
  "/chat": "Чат",
  "/patients": "Пациенты",
  "/patients/[id]": "Карточка пациента",
  "/courses": "Курсы",
  "/queue": "Кому позвонить",
  "/schedule": "Кабинеты",
  "/analytics": "Отчёты",
  "/owner": "Владелец",
  "/doctor": "Мой кабинет",
  "/help": "Справка",
  "/settings": "Настройки",
  "/settings/staff/[id]": "Карточка сотрудника",
  "/sistem": "Учёт",
};

export function routePattern(pathname: string): string {
  // Параметры и якорь отбрасываем ДО разбора: в них персональные данные (§7).
  const path = pathname.split("?")[0].split("#")[0];
  const clean = path.length > 1 ? path.replace(/\/+$/, "") : path;

  for (const base of WITH_ID) {
    if (clean.startsWith(`${base}/`)) {
      const rest = clean.slice(base.length + 1);
      // Только первый сегмент — идентификатор; вложенные экраны сохраняем.
      const [, ...tail] = rest.split("/");
      return [`${base}/[id]`, ...tail].join("/");
    }
  }
  return clean;
}

/**
 * Идентификатор из адреса, если он там есть.
 *
 * Нужен, чтобы «смотрел карточку» можно было связать с конкретным человеком,
 * не храня при этом адрес целиком.
 */
export function idFromRoute(pathname: string): string | null {
  const path = pathname.split("?")[0].split("#")[0];
  for (const base of WITH_ID) {
    if (path.startsWith(`${base}/`)) {
      const id = path.slice(base.length + 1).split("/")[0];
      return id || null;
    }
  }
  return null;
}

/** Подпись экрана для человека. Незнакомый адрес показываем как есть. */
export function screenLabel(pattern: string): string {
  return SCREEN_LABEL[pattern] ?? pattern;
}
