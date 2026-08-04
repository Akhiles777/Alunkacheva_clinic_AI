-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "contactName" TEXT;

-- RenameIndex
ALTER INDEX "staff_users_companyId_email_key" RENAME TO "staff_users_companyId_login_key";
