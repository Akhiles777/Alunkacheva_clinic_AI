import { prisma } from "../lib/db";
import { looksMedical } from "../lib/agent/gaps";

/**
 * Записи справочника школьной акции — то, что агент о ней знает.
 *
 * Агент видит акцию только через записи, привязанные к ней
 * (`KnowledgeEntry.promoId`, lib/agent/promo.ts): нет записей — акции для него
 * нет, и мама, пришедшая по ссылке «…на школьный ресурс [ШК]», получает обычный
 * разговор о записи без единого слова об акции. Записи заводились только руками
 * на экране акции, и на боевом сервере их не было ни одной.
 *
 * Тексты — с макета акции (состав, цены, сроки, возраст, «есть
 * противопоказания»), числа — из самой акции в базе (`items`, `priceTotal`,
 * `priceRegular`, `ageMin/Max`, `endsAt`): поправят цену на экране — следующий
 * прогон скрипта покажет расхождение, а не тихо разойдётся с ним. Ничего, чего
 * нет на макете, — пользы, показаний, подготовки — здесь нет намеренно (§6,
 * правило 1).
 *
 * Медицинская отметка ставится тем же правилом, что на экране акции
 * (`looksMedical`): запись со словом «анализ» или «противопоказания»
 * создаётся выключенной и ждёт «Утвердить» от врача или владельца. Агент
 * неутверждённую запись не видит.
 *
 * По умолчанию только показывает. `--apply` — добавляет записи, которых нет
 * (по теме); существующие не трогает. `--enable-agent` вместе с `--apply` —
 * ещё и включает «агент знает» у акции.
 *
 *   npx tsx --env-file=.env scripts/promo-knowledge.ts [--apply] [--enable-agent]
 */

const APPLY = process.argv.includes("--apply");
const ENABLE = process.argv.includes("--enable-agent");

const rub = (n: number) => `${new Intl.NumberFormat("ru-RU").format(n)} ₽`;
const dayMonth = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "Europe/Moscow" });

interface Item {
  title: string;
  price: number;
}

function itemsOf(raw: unknown): Item[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => x as { title?: unknown; price?: unknown })
    .filter((x) => typeof x.title === "string" && Number.isFinite(Number(x.price)))
    .map((x) => ({ title: String(x.title), price: Number(x.price) }));
}

function entriesFor(p: { items: unknown; priceTotal: unknown; priceRegular: unknown; ageMin: number | null; ageMax: number | null; endsAt: Date }) {
  const items = itemsOf(p.items);
  const total = Number(p.priceTotal);
  const regular = Number(p.priceRegular);
  const ages = p.ageMin != null && p.ageMax != null ? `${p.ageMin}–${p.ageMax} лет` : null;
  const until = dayMonth.format(p.endsAt);
  const list = items.map((i) => `• ${i.title.charAt(0).toLowerCase()}${i.title.slice(1)} — ${rub(i.price)}`).join("\n");
  return [
    {
      topic: "Школьный ресурс 6+ — что входит и сколько стоит",
      question:
        "Что за школьный ресурс? Школьный ресурс 6+. Школьный check-up, чек-ап. Что входит в акцию для школьников? Сколько стоит? До какого числа акция? С какого возраста?",
      answer:
        `«Школьный ресурс 6+» (школьный check-up) — акция для детей${ages ? ` ${ages}` : ""}. В неё входит:\n${list}\n\n` +
        `По отдельности — ${rub(regular)}, по акции — ${rub(total)}. Акция действует до ${until}. ` +
        "Есть противопоказания, необходима консультация специалиста. Время записи подберёт администратор.",
    },
    {
      // Отдельно от состава: на вопрос о противопоказаниях иначе уходил весь
      // список с ценами второй раз. Текст — дословно с макета, своего ничего.
      topic: "Акция — противопоказания",
      // Без слов «школьный ресурс»: иначе запись перебивает основную на общий
      // вопрос об акции (прогон 20 октября: «Что за школьный ресурс?» получало
      // одну фразу о противопоказаниях).
      question: "Какие противопоказания? Есть ли противопоказания? Подойдёт ли ребёнку с заболеванием? Можно ли, если есть болезнь?",
      answer: "Есть противопоказания, необходима консультация специалиста.",
    },
  ];
}

async function main() {
  const promos = await prisma.promo.findMany({
    select: { id: true, companyId: true, name: true, items: true, priceTotal: true, priceRegular: true, ageMin: true, ageMax: true, endsAt: true, agentEnabled: true, isActive: true },
    orderBy: { createdAt: "asc" },
  });
  if (!promos.length) console.log("Акций нет: откройте экран «Школьный ресурс» — акция заведётся, затем запустите скрипт снова.");
  for (const p of promos) {
    console.log(`\n«${p.name}» · акция ${p.isActive ? "включена" : "ВЫКЛЮЧЕНА"} · агент ${p.agentEnabled ? "знает" : "НЕ знает"}`);
    for (const e of entriesFor(p)) {
      const medical = looksMedical(`${e.topic} ${e.question} ${e.answer}`);
      const existing = await prisma.knowledgeEntry.findFirst({
        where: { companyId: p.companyId, promoId: p.id, topic: { equals: e.topic, mode: "insensitive" } },
        select: { isActive: true, answer: true, needsDoctorApproval: true, approvedAt: true },
      });
      if (existing) {
        const state = existing.isActive ? "включена" : existing.needsDoctorApproval && !existing.approvedAt ? "ждёт утверждения" : "выключена";
        console.log(`  · «${e.topic}» уже есть (${state}) — не трогаю.`);
        if (existing.answer.trim() !== e.answer.trim()) console.log("    ! текст отличается от данных акции — сверьте на экране акции:\n" + e.answer.replace(/^/gm, "      "));
        continue;
      }
      console.log(`  + «${e.topic}»${medical ? " — медицинская: создаётся выключенной, нужно «Утвердить»" : ""}\n${e.answer.replace(/^/gm, "      ")}`);
      if (APPLY)
        await prisma.knowledgeEntry.create({
          data: { companyId: p.companyId, promoId: p.id, ...e, needsDoctorApproval: medical, isActive: !medical },
        });
    }
    if (APPLY && ENABLE && !p.agentEnabled) {
      await prisma.promo.update({ where: { id: p.id }, data: { agentEnabled: true } });
      console.log("  ✓ «агент знает» включено");
    }
  }
  console.log(APPLY ? "\nГотово." : "\nСухой прогон. С --apply записи будут добавлены (с --enable-agent — и включено «агент знает»).");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
