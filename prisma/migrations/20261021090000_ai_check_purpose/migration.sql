-- Только добавление: зачем шла проверка переписки. Прежние строки — поиск улики.
ALTER TABLE "ai_attribution_checks" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'FIND';
