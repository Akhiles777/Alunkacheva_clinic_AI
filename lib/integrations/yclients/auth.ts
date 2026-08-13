import { YCLIENTS_ACCEPT, YCLIENTS_BASE_URL } from "./config";

/**
 * Подключение к YCLIENTS: получение пользовательского токена и списка филиалов.
 *
 * Партнёрского токена одного мало — API отвечает «Не указаны авторизационные
 * данные». Нужен второй, пользовательский: YCLIENTS выдаёт его в обмен на
 * логин и пароль сотрудника клиники. Раньше получить его можно было только
 * запросом руками и вписать в базу; здесь то же самое делает кнопка в
 * настройках.
 *
 * Логин и пароль нигде не сохраняются: они нужны ровно на один запрос. В базу
 * ложится только выданный токен, зашифрованным.
 *
 * Про рубильник YCLIENTS_ENABLED. Он запрещает фоновые обращения к API, пока
 * интеграция не подключена, — и это правило остаётся. Здесь исключение по
 * существу: запрос делает человек, нажавший кнопку в настройках, и без него
 * подключиться невозможно вовсе.
 */

const TIMEOUT_MS = 20_000;

export interface AuthResult {
  ok: boolean;
  userToken?: string;
  /** Причина словами: её увидит администратор, а не разработчик. */
  error?: string;
}

export interface YclientsBranch {
  id: number;
  title: string;
}

async function call(
  path: string,
  init: { method?: string; auth: string; body?: unknown },
): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(`${YCLIENTS_BASE_URL}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Accept: YCLIENTS_ACCEPT,
        "Content-Type": "application/json",
        Authorization: init.auth,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return {
      ok: false,
      error: (e as Error).name === "TimeoutError" ? "YCLIENTS не ответил вовремя" : "нет связи с YCLIENTS",
    };
  }

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: `YCLIENTS ответил ${res.status} без данных` };
  }

  const body = json as { success?: boolean; meta?: { message?: string }; data?: unknown };
  if (!res.ok || body?.success === false) {
    // Сообщение YCLIENTS понятнее любого нашего пересказа: «Неверный логин или
    // пароль», «Не указаны авторизационные данные».
    return { ok: false, error: body?.meta?.message || `YCLIENTS ответил ${res.status}` };
  }
  return { ok: true, json };
}

/** Пользовательский токен по логину и паролю сотрудника клиники. */
export async function fetchUserToken(
  partnerToken: string,
  login: string,
  password: string,
): Promise<AuthResult> {
  const res = await call("/auth", {
    method: "POST",
    auth: `Bearer ${partnerToken}`,
    body: { login, password },
  });
  if (!res.ok) return { ok: false, error: res.error };

  const data = (res.json as { data?: { user_token?: string } }).data;
  if (!data?.user_token) return { ok: false, error: "YCLIENTS не вернул пользовательский токен" };
  return { ok: true, userToken: data.user_token };
}

/**
 * Филиалы, доступные этому пользователю.
 *
 * Нужны, чтобы администратор выбрал филиал из списка, а не искал его номер в
 * адресной строке кабинета. Ошибиться номером здесь дорого: выгрузка приедет
 * из чужой клиники.
 */
export async function fetchBranches(
  partnerToken: string,
  userToken: string,
): Promise<{ ok: boolean; branches?: YclientsBranch[]; error?: string }> {
  const res = await call("/companies?my=1", {
    auth: `Bearer ${partnerToken}, User ${userToken}`,
  });
  if (!res.ok) return { ok: false, error: res.error };

  const data = (res.json as { data?: unknown }).data;
  if (!Array.isArray(data)) return { ok: false, error: "YCLIENTS вернул неожиданный ответ" };

  const branches = data
    .map((c) => c as { id?: unknown; title?: unknown })
    .filter((c) => typeof c.id === "number")
    .map((c) => ({ id: c.id as number, title: String(c.title ?? `Филиал ${c.id}`) }));

  if (!branches.length) return { ok: false, error: "У этого пользователя нет доступных филиалов" };
  return { ok: true, branches };
}
