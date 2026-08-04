-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "bookedByName" TEXT;

-- CreateTable
CREATE TABLE "staff_rates" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "hourlyRate" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "perProcedureRate" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "procedureKind" "ServiceKind",
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "staff_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_payouts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "paidAt" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_rates_staffId_key" ON "staff_rates"("staffId");

-- CreateIndex
CREATE INDEX "staff_rates_companyId_idx" ON "staff_rates"("companyId");

-- CreateIndex
CREATE INDEX "payroll_payouts_companyId_staffId_paidAt_idx" ON "payroll_payouts"("companyId", "staffId", "paidAt");

-- AddForeignKey
ALTER TABLE "staff_rates" ADD CONSTRAINT "staff_rates_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_rates" ADD CONSTRAINT "staff_rates_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_payouts" ADD CONSTRAINT "payroll_payouts_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_payouts" ADD CONSTRAINT "payroll_payouts_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_payouts" ADD CONSTRAINT "payroll_payouts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
