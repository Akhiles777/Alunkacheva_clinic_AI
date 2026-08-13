import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import type { Role } from "@/lib/permissions";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";

/**
 * Текущая сессия — серверная, из подписанной куки. getSessionOrNull возвращает
 * реальную сессию или null (для гарда: нет сессии → на /login). getSession
 * добавляет дев-фоллбэк (первая клиника, OWNER), чтобы серверные действия не
 * падали, если гард обошли; в дашборд без входа не попасть.
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
