import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import type { Role } from "@/lib/permissions";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";

/**
 * Текущая сессия — серверная, из подписанной куки.
 *
 * `getSessionOrNull` возвращает реальную сессию или null — им пользуется гард
 * на входе в дашборд. `getSession` требует сессию: в продакшене её отсутствие
 * это ошибка со внятным текстом, и никакой подстановки прав. Запасной путь
 * «первая клиника, OWNER» остался только для локальной разработки, где базу
 * поднимают без входа.
 */
export interface Session {
  companyId: string;
  userId: string | null;
  role: Role;
}

export async function getSessionOrNull(): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const payload = verifySession(token);
  if (!payload) return null;
  return { companyId: payload.companyId, userId: payload.userId, role: payload.role as Role };
}

export async function getSession(): Promise<Session> {
  const real = await getSessionOrNull();
  if (real) return real;

  /**
   * В продакшене подмены сессии нет и быть не может.
   *
   * Дальше шёл запасной путь «первая клиника, роль OWNER». Он писался как
   * удобство для разработки, но работал везде, и это была дыра: серверное
   * действие, вызванное БЕЗ действительной сессии, получало права владельца на
   * всю клинику. Гард на входе в дашборд от этого не спасает — он проверяет
   * страницу, а серверные действия вызываются с уже открытой вкладки и мимо
   * него.
   *
   * Тот же путь объясняет и «выходят ошибки»: кука истекла (тридцать суток),
   * вкладка осталась открытой, действие пошло по запасному пути с
   * `userId: null` — и всё, что требует конкретного сотрудника, падало
   * невнятной ошибкой вместо просьбы войти заново.
   */
  if (process.env.NODE_ENV === "production") {
    throw new Error("Сессия закончилась. Войдите заново — страница входа на /login.");
  }

  const company = await prisma.company.findFirst({ orderBy: { createdAt: "asc" } });
  if (!company) {
    /**
     * Клиники в базе нет — значит начальные данные не заводились.
     *
     * Раньше здесь бросалось исключение, и любая страница отвечала «A server
     * error occurred» с непонятным кодом. На свежем сервере это первое, что
     * видит человек после развёртывания, и понять из этого нечего. Бросаем
     * ошибку с текстом, который прямо говорит, что делать: экран покажет его
     * вместо безымянного сбоя.
     */
    throw new Error(
      "База пуста: не заведена клиника. Выполните на сервере `docker compose run --rm migrate npx prisma db seed`",
    );
  }
  return { companyId: company.id, userId: null, role: "OWNER" };
}
