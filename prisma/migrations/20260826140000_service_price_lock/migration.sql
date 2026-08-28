-- Цена услуги, заданная у нас, переставала теряться при выгрузке.
--
-- «Настройки → Услуги» позволяли изменить цену, а ближайшая выгрузка
-- возвращала значение из YCLIENTS. Правка не держалась пятнадцати минут, и со
-- стороны это выглядело как «цена не сохраняется».
ALTER TABLE "services" ADD COLUMN "priceLocked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "services" ADD COLUMN "yclientsPrice" DECIMAL(12,2);
