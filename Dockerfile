# Образ платформы клиники.
#
# Три стадии: зависимости, сборка, запуск. В финальный образ не попадают ни
# исходники, ни dev-зависимости — только автономная сборка Next и то, что
# нужно Prisma в рантайме.
#
# Секреты на этапе сборки не нужны и не передаются: приложение читает их из
# окружения при запуске. Это осознанно — иначе ключи оседают в слоях образа.

FROM node:22-alpine AS deps
WORKDIR /app
# Prisma и sharp тянут нативные части; на alpine им нужен libc.
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json* ./
RUN npm ci


FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Клиент Prisma генерируется до сборки: страницы импортируют типы из него.
RUN npx prisma generate

# Сборка не обращается к базе: подключение создаётся лениво, при первом
# запросе. Поэтому DATABASE_URL здесь не нужен.
ENV NEXT_TELEMETRY_DISABLED=1
# Открытый ключ push встраивается в код при сборке: браузер подписывается
# именно им. Без него уведомления молча не работают, поэтому значение
# передаётся аргументом сборки.
ARG NEXT_PUBLIC_VAPID_PUBLIC=""
ENV NEXT_PUBLIC_VAPID_PUBLIC=${NEXT_PUBLIC_VAPID_PUBLIC}
# Автономная сборка нужна образу — и только ему. На сервере под pm2 приложение
# поднимается через `next start`, а он с ней не работает и предупреждает об
# этом при каждом запуске.
ENV NEXT_OUTPUT=standalone
RUN npm run build


# Стадия миграций.
#
# Отдельная от рантайма намеренно. Prisma CLI — инструмент разработки: ему нужны
# prisma.config.ts (в схеме адреса базы нет, он приходит оттуда), tsx для сида и
# весь пакет зависимостей CLI. Прежде миграции пытались идти из тощего образа с
# вручную отобранными папками node_modules, и обе опоры отсутствовали: CLI падал
# на `Cannot find module 'effect'`, а до подключения к базе дело не доходило.
# Итог на сервере — база без единой таблицы и «A server error occurred» на любой
# странице. Здесь окружение полное, потому что этот контейнер разовый: он
# отрабатывает и завершается, в приложение эти килобайты не попадают.
FROM builder AS migrate
WORKDIR /app
ENV NODE_ENV=production
CMD ["sh", "-c", "npx prisma migrate deploy && npx prisma db seed"]


FROM node:22-alpine AS runner
WORKDIR /app
RUN apk add --no-cache libc6-compat

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Работаем не от root: у процесса нет прав менять систему, даже если его
# удастся скомпрометировать.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Клиент Prisma для рантайма. Самого CLI здесь нет: миграции накатывает стадия
# migrate, а неполная его копия только создавала видимость, что из этого образа
# можно что-то мигрировать.
COPY --from=builder --chown=nextjs:nodejs /app/prisma/schema.prisma ./prisma/schema.prisma
COPY --from=builder --chown=nextjs:nodejs /app/generated ./generated
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma

USER nextjs
EXPOSE 3000

# Проверка живости для оркестратора: отвечает без обращения к базе, поэтому
# недоступность базы не приводит к перезапуску контейнера по кругу.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
