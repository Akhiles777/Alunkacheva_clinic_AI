/**
 * Учения по выгрузке YCLIENTS без доступа к настоящему API.
 *
 * Поднимает поддельный сервер, отвечающий в формате YCLIENTS, и прогоняет
 * через него полный цикл: справочники, клиенты, визиты, повторный прогон,
 * сверку и обратную запись. Это единственный способ проверить конвейер
 * целиком, пока нет боевых ключей: пагинацию, окна по датам, разбор конверта,
 * идемпотентность и сопоставление пациентов.
 *
 * Чего проверка НЕ доказывает: что имена полей у реального YCLIENTS такие же.
 * Она доказывает, что при ожидаемом формате всё работает и повторный прогон
 * не плодит дублей.
 *
 *   DATABASE_URL=... npx tsx scripts/yclients-drill.ts
 */
import { createServer } from "node:http";
import { prisma } from "../lib/db";

const PORT = 8787;
const COMPANY_YCLIENTS_ID = 777;

/** Сколько сущностей отдаёт поддельный сервер. Больше страницы — намеренно. */
const STAFF_COUNT = 6;
const SERVICE_COUNT = 8;
const ROOM_COUNT = 3;
const CLIENT_COUNT = 450;
const RECORDS_PER_MONTH = 260;

let requestCount = 0;
const seenPaths = new Set<string>();

function services() {
  return Array.from({ length: SERVICE_COUNT }, (_, i) => ({
    id: 100 + i,
    title: `Услуга ${i + 1}`,
    price_min: 1000 + i * 500,
    seance_length: 1800 + i * 600,
    category: i % 2 === 0 ? "Остеопатия" : "БОС",
    active: 1,
  }));
}
function staff() {
  return Array.from({ length: STAFF_COUNT }, (_, i) => ({
    id: 200 + i,
    name: `Специалист ${i + 1}`,
    specialization: i % 2 === 0 ? "Остеопат" : "БОС-терапевт",
    fired: 0,
  }));
}
function resources() {
  return Array.from({ length: ROOM_COUNT }, (_, i) => ({ id: 300 + i, title: `Кабинет ${i + 1}` }));
}
function clients(page: number, count: number) {
  const from = (page - 1) * count;
  return Array.from({ length: Math.max(0, Math.min(count, CLIENT_COUNT - from)) }, (_, i) => {
    const n = from + i;
    return {
      id: 1000 + n,
      name: `Пациент ${n + 1}`,
      // Номера разные и валидные: сопоставление идёт по ним.
      phone: `+79${String(100000000 + n).slice(0, 9)}`,
    };
  });
}
function records(startDate: string, page: number, count: number) {
  const from = (page - 1) * count;
  const total = RECORDS_PER_MONTH;
  return Array.from({ length: Math.max(0, Math.min(count, total - from)) }, (_, i) => {
    const n = from + i;
    const day = String((n % 27) + 1).padStart(2, "0");
    const hour = String(9 + (n % 10)).padStart(2, "0");
    return {
      id: Number(`${startDate.slice(0, 4)}${startDate.slice(5, 7)}${String(n).padStart(4, "0")}`),
      staff_id: 200 + (n % STAFF_COUNT),
      datetime: `${startDate.slice(0, 8)}${day}T${hour}:00:00+03:00`,
      seance_length: 3600,
      services: [{ id: 100 + (n % SERVICE_COUNT), cost: 3000 }],
      client: { id: 1000 + (n % CLIENT_COUNT), phone: `+79${String(100000000 + (n % CLIENT_COUNT)).slice(0, 9)}` },
      visit_attendance: n % 5 === 0 ? 1 : 0,
      resource_instances: [{ resource_id: 300 + (n % ROOM_COUNT) }],
    };
  });
}

/**
 * Поддельный YCLIENTS.
 *
 * Важное про достоверность. Первая версия этого сервера повторяла мои же
 * догадки об их API — и потому не поймала две настоящие ошибки: кабинеты
 * запрашивались по несуществующему адресу /company/{id}/resources, а поиск
 * клиентов уходил методом GET, на который YCLIENTS отвечает 405. Учения
 * проходили, выгрузка у клиники падала.
 *
 * Теперь маршруты повторяют поведение, проверенное на боевом API:
 *   • кабинеты — GET /resources/{id}; адрес /company/{id}/resources даёт 404;
 *   • клиенты — только POST /company/{id}/clients/search, страница и размер
 *     в теле; на GET отвечаем 405, как настоящий сервер.
 */
function start() {
  return createServer((req, res) => {
    requestCount += 1;
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const p = url.pathname;
    seenPaths.add(`${req.method} ${p.replace(/\d+/g, ":id")}`);

    const send = (data: unknown, total?: number) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: true, data, meta: total === undefined ? {} : { total_count: total } }));
    };
    const fail = (code: number, message: string) => {
      res.statusCode = code;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: false, data: null, meta: { message } }));
    };

    const readBody = (): Promise<Record<string, unknown>> =>
      new Promise((resolve) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          try {
            resolve(JSON.parse(raw || "{}"));
          } catch {
            resolve({});
          }
        });
      });

    const qPage = Number(url.searchParams.get("page") ?? 1);
    const qCount = Number(url.searchParams.get("count") ?? 200);

    // Поиск клиентов: только POST, страница и размер в теле.
    if (p.endsWith("/clients/search")) {
      if (req.method !== "POST") return fail(405, "MethodNotAllowed");
      return void readBody().then((body) => {
        const page = Number(body.page ?? 1);
        const count = Number(body.count ?? 200);
        send(clients(page, count), CLIENT_COUNT);
      });
    }

    if (req.method === "POST" && p.startsWith("/records/")) return send({ id: 987654 });
    if (req.method === "PUT" && p.startsWith("/record/")) return send({ id: 987654 });
    if (req.method === "DELETE" && p.startsWith("/record/")) return send({ ok: true });

    if (p.endsWith("/services")) return send(services());
    if (p.endsWith("/staff")) return send(staff());
    // Настоящий YCLIENTS отдаёт кабинеты только по /resources/{id}.
    if (p.startsWith("/resources/")) return send(resources());
    if (p.endsWith("/resources")) return fail(404, "Произошла ошибка");
    if (p.startsWith("/records/")) {
      const startDate = url.searchParams.get("start_date") ?? "2026-01-01";
      return send(records(startDate, qPage, qCount), RECORDS_PER_MONTH);
    }
    return fail(404, "Произошла ошибка");
  }).listen(PORT);
}

async function counts() {
  const [staffN, serviceN, roomN, patientN, phoneN, apptN, dupPhones] = await Promise.all([
    prisma.staff.count({ where: { yclientsStaffId: { not: null } } }),
    prisma.service.count({ where: { yclientsServiceId: { not: null } } }),
    prisma.room.count({ where: { yclientsResourceId: { not: null } } }),
    prisma.patient.count({ where: { yclientsId: { not: null } } }),
    prisma.patientPhone.count(),
    prisma.appointment.count({ where: { yclientsRecordId: { not: null } } }),
    prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint n FROM (
        SELECT 1 FROM patient_phones GROUP BY "companyId", phone HAVING count(*) > 1
      ) x`,
  ]);
  return { staffN, serviceN, roomN, patientN, phoneN, apptN, dupPhones: Number(dupPhones[0]?.n ?? 0) };
}

async function main() {
  const server = start();
  process.env.YCLIENTS_ENABLED = "true";
  process.env.YCLIENTS_BASE_URL = `http://127.0.0.1:${PORT}`;
  process.env.YCLIENTS_MIN_INTERVAL_MS = "0";
  process.env.YCLIENTS_HISTORY_YEARS = "1";

  const { syncAll } = await import("../lib/integrations/yclients/sync");
  const { reconcile } = await import("../lib/integrations/yclients/reconcile");

  const company = await prisma.company.findFirst({ orderBy: { createdAt: "asc" } });
  if (!company) throw new Error("нет компании — сначала прогоните миграции и сид");

  // Ключи в базе: клиент их читает оттуда, а не из окружения.
  const { encryptSecret } = await import("../lib/crypto");
  for (const [keyName, value] of [
    ["partner_token", "test-partner"],
    ["user_token", "test-user"],
    ["company_id", String(COMPANY_YCLIENTS_ID)],
  ] as const) {
    await prisma.credential.upsert({
      where: { companyId_provider_keyName: { companyId: company.id, provider: "yclients", keyName } },
      update: { valueEncrypted: encryptSecret(value) },
      create: { companyId: company.id, provider: "yclients", keyName, valueEncrypted: encryptSecret(value) },
    });
  }

  console.log("=== ПРОГОН 1: начальная выгрузка ===");
  const t1 = Date.now();
  const first = await syncAll(company.id);
  const after1 = await counts();
  console.log(`  за ${((Date.now() - t1) / 1000).toFixed(1)} с, запросов к API: ${requestCount}`);
  console.log(`  ${JSON.stringify(first.counts)}`);
  console.log(`  в базе: ${JSON.stringify(after1)}`);
  if (first.errors.length) console.log(`  ошибки: ${first.errors.join(" | ")}`);

  console.log("\n=== ПРОГОН 2: повторный (идемпотентность) ===");
  requestCount = 0;
  const second = await syncAll(company.id);
  const after2 = await counts();
  console.log(`  ${JSON.stringify(second.counts)}`);
  console.log(`  в базе: ${JSON.stringify(after2)}`);

  const same =
    after1.patientN === after2.patientN &&
    after1.apptN === after2.apptN &&
    after1.staffN === after2.staffN &&
    after1.serviceN === after2.serviceN &&
    after1.phoneN === after2.phoneN;
  console.log(`  дублей не появилось: ${same ? "ДА" : "НЕТ — ЭТО ОШИБКА"}`);
  console.log(`  дублей телефонов: ${after2.dupPhones}`);

  console.log("\n=== СВЕРКА ===");
  const report = await reconcile(company.id);
  for (const e of report.entities) {
    console.log(`  ${e.entity.padEnd(14)} у них ${String(e.remote).padStart(5)}  у нас ${String(e.local).padStart(5)}  ${e.ok ? "сходится" : "РАСХОЖДЕНИЕ " + (e.note ?? "")}`);
  }
  console.log(`  итог: ${report.ok ? "расхождений нет" : "ЕСТЬ РАСХОЖДЕНИЯ"}`);

  console.log("\n=== ПУТИ, КОТОРЫЕ ЗАДЕЙСТВОВАЛ КОД ===");
  for (const p of [...seenPaths].sort()) console.log(`  ${p}`);

  server.close();
  await prisma.$disconnect();
}

void main().catch((e) => {
  console.error("УЧЕНИЯ УПАЛИ:", e);
  process.exit(1);
});
