-- Отметка о прочтении диалога сотрудником: по ней считается «нужен ответ».
ALTER TABLE "conversations" ADD COLUMN "staffReadAt" TIMESTAMPTZ(3);
