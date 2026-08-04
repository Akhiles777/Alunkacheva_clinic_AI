-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "pushError" TEXT,
ADD COLUMN     "pushedAt" TIMESTAMPTZ(3);
