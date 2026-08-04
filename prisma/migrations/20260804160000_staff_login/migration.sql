-- Вход сотрудника — логин, а не почта. Клиника заводит людей вручную, и
-- требовать адрес электронной почты ради входа незачем: у медсестры её может
-- просто не быть. Переименование сохраняет данные — существующие значения
-- продолжают работать как логины.
ALTER TABLE "staff_users" RENAME COLUMN "email" TO "login";

-- Существующие логины вида owner@mera.clinic укорачиваем до части перед @:
-- пользоваться «owner» удобнее, а уникальность в пределах клиники сохраняется.
UPDATE "staff_users" u
SET "login" = split_part(u."login", '@', 1)
WHERE u."login" LIKE '%@%'
  AND NOT EXISTS (
    SELECT 1 FROM "staff_users" other
    WHERE other."companyId" = u."companyId"
      AND other."id" <> u."id"
      AND other."login" = split_part(u."login", '@', 1)
  );
