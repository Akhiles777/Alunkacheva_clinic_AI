/**
 * Что на самом деле отдаёт YCLIENTS этой клинике.
 *
 * Нужен, когда выгрузка прошла «успешно», а данных нет или они пустые. Гадать
 * по нашим таблицам бессмысленно: непонятно, чего не прислал YCLIENTS, а что
 * потеряли мы. Здесь мы спрашиваем их напрямую теми же ключами, что и
 * выгрузка, и показываем структуру ответа.
 *
 * Персональные данные наружу не выводятся: имена и телефоны заменяются
 * пометками «есть» / «пусто». Нам важно, приходит ли поле, а не что в нём.
 *
 * Запуск из каталога проекта: npx tsx scripts/yclients-probe.ts
 * Переменные берутся из .env — без CREDENTIAL_MASTER_KEY ключи интеграции
 * расшифровать нечем, и проверка решит, что их нет вовсе.
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { loadYclientsCredentials, authHeader } from "../lib/integrations/yclients/credentials";
import { YCLIENTS_ACCEPT, YCLIENTS_BASE_URL } from "../lib/integrations/yclients/config";

type Json = Record<string, unknown>;

async function call(
  path: string,
  auth: string,
  init?: { method?: "GET" | "POST"; body?: unknown },
): Promise<{ status: number; data: unknown; total: number | null; message: string | null }> {
  const res = await fetch(`${YCLIENTS_BASE_URL}${path}`, {
    method: init?.method ?? "GET",
    headers: { Accept: YCLIENTS_ACCEPT, "Content-Type": "application/json", Authorization: auth },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  let json: Json = {};
  try {
    json = (await res.json()) as Json;
  } catch {
    /* тело не json — оставим пустым */
  }
  const meta = json.meta as { message?: string; total_count?: number } | undefined;
  return {
    status: res.status,
    data: json.data,
    total: typeof meta?.total_count === "number" ? meta.total_count : null,
    message: meta?.message ?? null,
  };
}

/** Ключи объекта и признак заполненности — без самих значений. */
function shape(o: unknown): string {
  if (!o || typeof o !== "object") return String(o);
  const entries = Object.entries(o as Json)
    .slice(0, 24)
    .map(([k, v]) => {
      if (v === null || v === undefined || v === "") return `${k}: пусто`;
      if (typeof v === "object") return `${k}: {…}`;
      if (["name", "phone", "email", "surname", "patronymic", "comment"].includes(k)) return `${k}: есть`;
      return `${k}: ${String(v).slice(0, 22)}`;
    });
  return entries.join(", ");
}

function head(title: string) {
  console.log(`\n═══ ${title} ═══`);
}

async function main() {
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const creds = await loadYclientsCredentials(company.id);
  if (!creds) {
    const saved = await prisma.credential.findMany({
      where: { companyId: company.id, provider: "yclients" },
      select: { keyName: true },
    });
    console.error(
      saved.length === 0
        ? "Ключи YCLIENTS не заданы — подключите интеграцию в настройках"
        : `Ключи есть (${saved.map((s) => s.keyName).join(", ")}), но расшифровать не удалось. ` +
            "Проверьте CREDENTIAL_MASTER_KEY: запускать нужно из каталога проекта, где лежит .env",
    );
    process.exit(1);
  }
  const auth = authHeader(creds);
  const cid = creds.companyId;
  console.log(`филиал YCLIENTS: ${cid}`);

  head("СПЕЦИАЛИСТЫ");
  const staff = await call(`/company/${cid}/staff`, auth);
  const staffArr = Array.isArray(staff.data) ? staff.data : [];
  console.log(`статус ${staff.status}, пришло ${staffArr.length}${staff.message ? `, ${staff.message}` : ""}`);
  if (staffArr[0]) console.log(`поля: ${shape(staffArr[0])}`);
  // Уволенные и скрытые: понять, кого именно недосчитались.
  const fired = staffArr.filter((s) => (s as Json).fired === 1).length;
  const hidden = staffArr.filter((s) => (s as Json).hidden === 1).length;
  console.log(`из них уволенных: ${fired}, скрытых: ${hidden}`);

  head("КЛИЕНТЫ — без списка полей (как сейчас в выгрузке)");
  const plain = await call(`/company/${cid}/clients/search`, auth, {
    method: "POST",
    body: { page: 1, count: 5 },
  });
  const plainArr = Array.isArray(plain.data) ? plain.data : [];
  console.log(`статус ${plain.status}, всего у них ${plain.total ?? "не сообщили"}, на странице ${plainArr.length}`);
  if (plainArr[0]) console.log(`поля: ${shape(plainArr[0])}`);

  head("КЛИЕНТЫ — со списком полей");
  const withFields = await call(`/company/${cid}/clients/search`, auth, {
    method: "POST",
    body: {
      page: 1,
      count: 5,
      fields: ["id", "name", "phone", "email", "discount", "first_visit_date", "last_visit_date", "visits_count"],
    },
  });
  const fieldsArr = Array.isArray(withFields.data) ? withFields.data : [];
  console.log(
    `статус ${withFields.status}, всего у них ${withFields.total ?? "не сообщили"}, на странице ${fieldsArr.length}`,
  );
  if (fieldsArr[0]) console.log(`поля: ${shape(fieldsArr[0])}`);

  head("ВИЗИТЫ");
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  const records = await call(`/records/${cid}?start_date=${from}&end_date=${to}&page=1&count=5`, auth);
  const recArr = Array.isArray(records.data) ? records.data : [];
  console.log(
    `статус ${records.status}, период ${from}…${to}, всего ${records.total ?? "не сообщили"}, на странице ${recArr.length}`,
  );
  if (recArr[0]) {
    const r = recArr[0] as Json;
    console.log(`поля: ${shape(r)}`);
    console.log(`  staff_id: ${JSON.stringify((r.staff as Json)?.id ?? r.staff_id ?? null)}`);
    console.log(`  client: ${r.client ? shape(r.client) : "пусто"}`);
    console.log(`  services: ${Array.isArray(r.services) ? `${r.services.length} шт.` : "нет"}`);
  }

  head("ЧТО У НАС В БАЗЕ");
  const [services, staffN, rooms, patients, appts, withName, withPhone] = await Promise.all([
    prisma.service.count({ where: { companyId: company.id } }),
    prisma.staff.count({ where: { companyId: company.id } }),
    prisma.room.count({ where: { companyId: company.id } }),
    prisma.patient.count({ where: { companyId: company.id } }),
    prisma.appointment.count({ where: { companyId: company.id } }),
    prisma.patient.count({ where: { companyId: company.id, name: { not: null } } }),
    prisma.patientPhone.count({ where: { companyId: company.id } }),
  ]);
  console.log(
    `услуги ${services}, специалисты ${staffN}, кабинеты ${rooms}, пациенты ${patients} ` +
      `(с именем ${withName}, телефонов ${withPhone}), визиты ${appts}`,
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("проверка упала:", e);
  await prisma.$disconnect();
  process.exit(1);
});
