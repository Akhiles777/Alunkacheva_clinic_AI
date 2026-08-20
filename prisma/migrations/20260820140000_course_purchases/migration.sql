-- Продажа курса как самостоятельное событие.
--
-- Пока продажа хранилась внутри курса, её деньги ждали первого сеанса: клиника
-- продала курс 20 августа за 26 000 ₽, первый сеанс был позже — и в выручке
-- того дня этих денег не было. То же самое, когда пациент покупает следующий
-- курс, не закончив текущий.
CREATE TABLE "course_purchases" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "yclientsSaleId" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "purchasedAt" TIMESTAMPTZ(3) NOT NULL,
    "isCourse" BOOLEAN NOT NULL DEFAULT true,
    "courseId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "course_purchases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "course_purchases_companyId_yclientsSaleId_key" ON "course_purchases"("companyId", "yclientsSaleId");
CREATE INDEX "course_purchases_companyId_purchasedAt_idx" ON "course_purchases"("companyId", "purchasedAt");

ALTER TABLE "course_purchases" ADD CONSTRAINT "course_purchases_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "course_purchases" ADD CONSTRAINT "course_purchases_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "course_purchases" ADD CONSTRAINT "course_purchases_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
