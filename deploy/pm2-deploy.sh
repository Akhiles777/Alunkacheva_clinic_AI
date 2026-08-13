#!/usr/bin/env bash
#
# Выкладка на сервер с pm2.
#
# Главное правило: работающее приложение не страдает от неудачной сборки.
# Раньше `next build` пересобирал в тот же `.next`, из которого работал
# запущенный процесс. Next чистит каталог, живой сервер держит и создаёт там
# файлы, удаление падает с ENOTEMPTY — сборка умирает, оставив `.next`
# разрушенным. До первого перезапуска это незаметно: старая сборка уже в
# памяти. Потом рестарт — и сайт отвечает 502 с «Could not find a production
# build».
#
# Поэтому собираем в отдельный каталог и подменяем рабочий только после
# успеха. Предыдущая сборка сохраняется рядом — откатиться можно за секунду.
set -euo pipefail

cd "$(dirname "$0")/.."

BUILD_DIR=".next-build"
LIVE_DIR=".next"
PREV_DIR=".next-prev"

echo "── миграции ──"
npx prisma migrate deploy

echo "── сборка в отдельный каталог ──"
rm -rf "$BUILD_DIR"
NEXT_DIST_DIR="$BUILD_DIR" npm run build

# Сюда попадаем только при успешной сборке: set -e прервал бы выше.
if [ ! -d "$BUILD_DIR" ]; then
  echo "ОШИБКА: сборка завершилась, но каталог $BUILD_DIR не создан" >&2
  exit 1
fi

# Next дописывает в tsconfig.json пути с типами своего каталога сборки. На
# сервере это делает дерево грязным, и следующий `git pull` упирается в
# локальные изменения файла, который никто не трогал руками. Возвращаем как в
# репозитории: нужные пути там уже прописаны.
if git -C . diff --quiet -- tsconfig.json 2>/dev/null; then :; else
  git -C . checkout -- tsconfig.json 2>/dev/null || true
fi

echo "── подмена сборки ──"
rm -rf "$PREV_DIR"
[ -d "$LIVE_DIR" ] && mv "$LIVE_DIR" "$PREV_DIR"
mv "$BUILD_DIR" "$LIVE_DIR"

echo "── перезапуск ──"
# Пересоздаём процесс, а не перезапускаем: pm2 restart поднимает приложение с
# конфигурацией, запомненной при первом запуске, и новый путь из
# ecosystem.config.cjs не подхватывает.
pm2 delete clinic >/dev/null 2>&1 || true
pm2 start ecosystem.config.cjs --update-env
pm2 save

PORT_LINE=$(grep -E '^PORT=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' || true)
PORT="${PORT_LINE:-3001}"
sleep 3
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/ping" || echo 000)
echo "проверка: /api/ping → $CODE"
if [ "$CODE" != "200" ]; then
  echo "ВНИМАНИЕ: приложение не отвечает. Предыдущая сборка лежит в $PREV_DIR:" >&2
  echo "  rm -rf $LIVE_DIR && mv $PREV_DIR $LIVE_DIR && pm2 restart clinic --update-env" >&2
  exit 1
fi
echo "готово"
