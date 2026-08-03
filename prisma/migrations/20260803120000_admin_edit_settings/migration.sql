-- Администратор должен уметь менять настройки: он заводит сотрудников, услуги
-- и цены. Раньше пункт «Настройки» показывался администратору, но сохранение
-- падало с «Недостаточно прав» — интерфейс и матрица прав расходились.
-- Строки может не быть вовсе (правило «запрещено по умолчанию»), поэтому UPDATE
-- дополняем вставкой для тех компаний, где её нет.
UPDATE "role_permissions"
SET "allowed" = true, "updatedAt" = now()
WHERE "role" = 'ADMIN' AND "permission" = 'EDIT_SETTINGS';

INSERT INTO "role_permissions" ("id", "companyId", "role", "permission", "allowed", "updatedAt")
SELECT
  'rp_' || replace(gen_random_uuid()::text, '-', ''),
  c."id",
  'ADMIN',
  'EDIT_SETTINGS',
  true,
  now()
FROM "companies" c
WHERE NOT EXISTS (
  SELECT 1 FROM "role_permissions" rp
  WHERE rp."companyId" = c."id"
    AND rp."role" = 'ADMIN'
    AND rp."permission" = 'EDIT_SETTINGS'
);
