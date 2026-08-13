#!/usr/bin/env bash
#
# Перенос базы на боевой сервер.
#
# Забирает полную копию с текущего хостинга и загружает её в базу сервера.
# Данные клиники — переписка, база знаний, сотрудники, пациенты — переезжают
# целиком, вместе с историей миграций, поэтому после загрузки `migrate deploy`
# видит схему актуальной и ничего не трогает.
#
# Порядок:
#   ./deploy/import-dump.sh dump  "postgres://...источник..."   # снять копию
#   ./deploy/import-dump.sh load  dump-2026-08-13.dump          # загрузить
#
# Требуется pg_dump и pg_restore версии 17 — как у сервера. Клиент младшей
# версии молча отдаёт обрезанный файл: dump ниже проверяет это явно.
set -euo pipefail

MODE="${1:-}"
ARG="${2:-}"

# Минимальный размер осмысленной копии. Пустая база prisma отдаёт ~20 байт —
# ровно так выглядела неудачная попытка переноса, и заметить её без проверки
# невозможно до самого восстановления.
MIN_BYTES=10240

die() { echo "ОШИБКА: $*" >&2; exit 1; }

need_v17() {
  local tool="$1" ver
  command -v "$tool" >/dev/null || die "не найден $tool. macOS: brew install postgresql@17"
  ver="$("$tool" --version | grep -oE '[0-9]+' | head -1)"
  [ "$ver" -ge 17 ] || die "$tool версии $ver, а база сервера — 17. Возьмите клиент 17: brew install postgresql@17 (путь /opt/homebrew/opt/postgresql@17/bin)"
}

case "$MODE" in
  dump)
    [ -n "$ARG" ] || die "укажите строку подключения к источнику"
    need_v17 pg_dump
    OUT="dump-$(date +%Y-%m-%d-%H%M).dump"
    # --no-owner/--no-privileges: роли на сервере другие, права источника там
    # неприменимы и приводят к ошибкам восстановления.
    pg_dump --no-owner --no-privileges --format=custom --file="$OUT" "$ARG"
    SIZE=$(wc -c < "$OUT" | tr -d ' ')
    [ "$SIZE" -ge "$MIN_BYTES" ] || die "копия получилась $SIZE байт — это пустой файл, а не база. Проверьте строку подключения"
    echo "копия снята: $OUT ($(du -h "$OUT" | cut -f1))"
    echo "перенесите её на сервер и выполните: ./deploy/import-dump.sh load $OUT"
    ;;

  load)
    [ -n "$ARG" ] || die "укажите файл копии"
    [ -f "$ARG" ] || die "файл $ARG не найден"
    [ -f .env ] || die "нет .env — загружать некуда"
    # shellcheck disable=SC1091
    set -a; . ./.env; set +a
    # Значения по умолчанию те же, что подставляет docker-compose.yml: иначе
    # скрипт ругался бы на .env, с которым база прекрасно работает.
    POSTGRES_USER="${POSTGRES_USER:-clinic}"
    POSTGRES_DB="${POSTGRES_DB:-clinic}"

    # Через что работать с базой.
    #
    # На свежем VDS клиента PostgreSQL нет и ставить его ради одной загрузки
    # незачем: нужный pg_restore уже лежит в контейнере базы, и версия у него
    # заведомо совпадает с сервером. Клиент на хосте используем, только если он
    # есть и не младше — младший молча портит перенос.
    if command -v pg_restore >/dev/null && [ "$(pg_restore --version | grep -oE '[0-9]+' | head -1)" -ge 17 ]; then
      VIA="host"
    elif docker compose ps db >/dev/null 2>&1; then
      VIA="docker"
    else
      die "нет ни pg_restore 17 на хосте, ни поднятого контейнера базы. Запустите: docker compose up -d db"
    fi
    echo "работаем через: $VIA"

    # Единая точка обращения к базе — дальше по коду неважно, где живёт клиент.
    dbq() { # SQL -> одна строка
      if [ "$VIA" = "host" ]; then
        psql "$DATABASE_URL" -Atc "$1"
      else
        docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"
      fi
    }

    # База должна быть готова принимать запросы: сразу после `up -d` она ещё
    # поднимается, и «нет таблиц» тогда означало бы «не достучались», а не
    # «пусто». Отличить это по количеству строк невозможно.
    READY=""
    for _ in $(seq 1 30); do
      if dbq "select 1" >/dev/null 2>&1; then READY="да"; break; fi
      sleep 1
    done
    [ -n "$READY" ] || die "база не отвечает. Проверьте: docker compose ps db"

    # Загружаем только в пустую базу. Восстановление поверх работающей клиники
    # смешало бы две истории: строки с одинаковыми идентификаторами упали бы на
    # уникальных индексах, а остальные легли бы вперемешку — разобрать такое
    # потом нельзя. Сначала снимите резервную копию и очистите базу осознанно.
    EXISTING=$(dbq "select count(*) from information_schema.tables where table_schema='public'" | tr -d '\r')
    if [ "$EXISTING" != "0" ] && [ "${FORCE:-}" != "true" ]; then
      die "в базе уже есть таблицы ($EXISTING). Загрузка поверх запрещена.
   Если это следы неудачной попытки и данных в базе не жаль — очистите схему:
     docker compose exec -T db psql -U $POSTGRES_USER -d $POSTGRES_DB -c 'drop schema public cascade; create schema public;'
   и повторите загрузку. Осознанно поверх: FORCE=true $0 load $ARG"
    fi

    # Расширение prisma_postgres существует только у управляемой базы prisma.io;
    # на обычном PostgreSQL его нет и быть не должно. Исключаем его из списка
    # объектов, иначе восстановление спотыкается на первом же шаге.
    if [ "$VIA" = "host" ]; then
      TOC=$(mktemp)
      pg_restore -l "$ARG" | grep -vi "prisma_postgres" > "$TOC"
      pg_restore --no-owner --no-privileges -L "$TOC" -d "$DATABASE_URL" "$ARG"
      rm -f "$TOC"
    else
      CID=$(docker compose ps -q db)
      [ -n "$CID" ] || die "контейнер базы не найден"
      docker cp "$ARG" "$CID:/tmp/import.dump"
      docker compose exec -T db sh -c \
        "pg_restore -l /tmp/import.dump | grep -vi prisma_postgres > /tmp/import.toc && \
         pg_restore --no-owner --no-privileges -L /tmp/import.toc -U $POSTGRES_USER -d $POSTGRES_DB /tmp/import.dump; \
         rm -f /tmp/import.dump /tmp/import.toc"
    fi

    echo "── что загрузилось ──"
    dbq "
      select 'клиники='||(select count(*) from companies)
        ||' сотрудники='||(select count(*) from staff_users)
        ||' пациенты='||(select count(*) from patients)
        ||' записи='||(select count(*) from appointments)
        ||' справочник='||(select count(*) from knowledge_entries)
        ||' сообщения='||(select count(*) from messages)"

    # Приложение работает с самой ранней клиникой. Если их несколько, стоит
    # убедиться, что данные лежат именно в ней, — иначе платформа откроется
    # пустой при полной базе.
    COMPANIES=$(dbq "select count(*) from companies" | tr -d '\r')
    if [ "$COMPANIES" -gt 1 ]; then
      echo
      echo "ВНИМАНИЕ: клиник в базе $COMPANIES. Платформа покажет самую раннюю (первая строка):"
      dbq "
        select c.id||'  '||c.\"createdAt\"
          ||'  сотрудников='||(select count(*) from staff_users s where s.\"companyId\"=c.id)
          ||'  справочник='||(select count(*) from knowledge_entries k where k.\"companyId\"=c.id)
        from companies c order by c.\"createdAt\""
    fi

    echo
    echo "готово. Теперь: docker compose up -d --build"
    ;;

  *)
    die "укажите режим: dump <строка подключения> | load <файл>"
    ;;
esac
