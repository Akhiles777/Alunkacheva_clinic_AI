-- Учёт устройств и перезапусков для раздела /sistem.
--
-- Только добавление таблиц: ничего не удаляется, не переименовывается и не
-- меняет тип. На горячем пути запросов этих таблиц нет — «известное
-- устройство» пишется один раз при входе, «перезапуск» один раз при старте
-- процесса.
CREATE TABLE "known_devices" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "userAgent" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "browser" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "logins" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "excludedAt" TIMESTAMPTZ(3),
    "note" TEXT,

    CONSTRAINT "known_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "known_devices_companyId_userId_fingerprint_key"
    ON "known_devices"("companyId", "userId", "fingerprint");
CREATE INDEX "known_devices_companyId_lastLoginAt_idx"
    ON "known_devices"("companyId", "lastLoginAt");

ALTER TABLE "known_devices" ADD CONSTRAINT "known_devices_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "known_devices" ADD CONSTRAINT "known_devices_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "staff_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "app_restarts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rssMb" INTEGER,
    "commit" TEXT,

    CONSTRAINT "app_restarts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "app_restarts_companyId_startedAt_idx"
    ON "app_restarts"("companyId", "startedAt");

ALTER TABLE "app_restarts" ADD CONSTRAINT "app_restarts_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
