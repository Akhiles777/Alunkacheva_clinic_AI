-- База знаний ассистента: убираем дубликаты и делаем их невозможными.
--
-- На боевом стенде накопилось 417 записей при 66 уникальных: сохранение
-- решало «создать или обновить» по идентификатору, присланному экраном, и
-- любой неопознанный идентификатор порождал копию. За один заход появилось
-- 369 копий.
--
-- Тексты не теряются: проверено, что внутри групп «тема + вопрос» ответы
-- совпадают полностью. Оставляем самую свежую по updatedAt — это последнее,
-- что редактировал человек.

-- 1. Если хоть одна копия была включена, включаем ту, что останется:
--    иначе выключённый оригинал увёл бы ответ из работы ассистента.
UPDATE "knowledge_entries" k SET "isActive" = true
FROM (
  SELECT "companyId", lower(btrim(topic)) t, lower(btrim(question)) q
  FROM "knowledge_entries"
  GROUP BY 1, 2, 3
  HAVING bool_or("isActive")
) g
WHERE k."companyId" = g."companyId"
  AND lower(btrim(k.topic)) = g.t
  AND lower(btrim(k.question)) = g.q
  AND NOT k."isActive";

-- 2. Оставляем по одной записи в каждой группе.
DELETE FROM "knowledge_entries" WHERE id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (
      PARTITION BY "companyId", lower(btrim(topic)), lower(btrim(question))
      ORDER BY "updatedAt" DESC, "createdAt" ASC
    ) rn
    FROM "knowledge_entries"
  ) ranked WHERE rn > 1
);

-- 3. Запрет на повторение. Дальше дубликат не создаст ни ошибка в коде, ни
--    двойное нажатие: база просто не примет вторую такую строку.
CREATE UNIQUE INDEX "knowledge_entries_companyId_topic_question_key"
  ON "knowledge_entries" ("companyId", lower(btrim(topic)), lower(btrim(question)));
