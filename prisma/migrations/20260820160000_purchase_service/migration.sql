-- Услуга покупки, опознанная по сумме.
--
-- Курс собирается, только когда пациент начал ходить, а услуга известна
-- раньше: 26 000 ₽ — это курс БОС, а не курс НАК по 1 000 ₽ за сеанс. Без неё
-- покупка стояла в операциях дня как «услуга не определена».
ALTER TABLE "course_purchases" ADD COLUMN "serviceId" TEXT;

CREATE INDEX "course_purchases_serviceId_idx" ON "course_purchases"("serviceId");

ALTER TABLE "course_purchases" ADD CONSTRAINT "course_purchases_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;
