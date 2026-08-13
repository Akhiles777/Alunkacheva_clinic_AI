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
    need_v17 pg_restore
    [ -f .env ] || die "нет .env — загружать некуда"
    # shellcheck disable=SC1091
    set -a; . ./.env; set +a
    [ -n "${DATABASE_URL:-}" ] || die "в .env не задан DATABASE_URL"

    # Загружаем только в пустую базу. Восстановление поверх работающей клиники
    # смешало бы две истории: строки с одинаковыми идентификаторами упали бы на
    # уникальных индексах, а остальные легли бы вперемешку — разобрать такое
    # потом нельзя. Сначала снимите резервную копию и очистите базу осознанно.
    EXISTING=$(psql "$DATABASE_URL" -Atc \
      "select count(*) from information_schema.tables where table_schema='public'" 2>/dev/null || echo "0")
    if [ "$EXISTING" != "0" ] && [ "${FORCE:-}" != "true" ]; then
      die "в базе уже есть таблицы ($EXISTING). Загрузка поверх запрещена. Осознанно: FORCE=true $0 load $ARG"
    fi

    # Расширение prisma_postgres существует только у управляемой базы prisma.io;
    # на обычном PostgreSQL его нет и быть не должно.
    TOC=$(mktemp)
    pg_restore -l "$ARG" | grep -vi "prisma_postgres" > "$TOC"

    pg_restore --no-owner --no-privileges -L "$TOC" -d "$DATABASE_URL" "$ARG"
    rm -f "$TOC"

    echo "── что загрузилось ──"
    psql "$DATABASE_URL" -Atc "
      select 'клиники='||(select count(*) from companies)
        ||' сотрудники='||(select count(*) from staff_users)
        ||' пациенты='||(select count(*) from patients)
        ||' записи='||(select count(*) from appointments)
        ||' справочник='||(select count(*) from knowledge_entries)
        ||' сообщения='||(select count(*) from messages)"

    # Приложение работает с самой ранней клиникой. Если их несколько, стоит
    # убедиться, что данные лежат именно в ней, — иначе платформа откроется
    # пустой при полной базе.
    COMPANIES=$(psql "$DATABASE_URL" -Atc "select count(*) from companies")
    if [ "$COMPANIES" -gt 1 ]; then
      echo
      echo "ВНИМАНИЕ: клиник в базе $COMPANIES. Платформа покажет самую раннюю:"
      psql "$DATABASE_URL" -c "
        select c.id, c.\"createdAt\",
               (select count(*) from staff_users s where s.\"companyId\"=c.id) as сотрудники,
               (select count(*) from knowledge_entries k where k.\"companyId\"=c.id) as справочник
        from companies c order by c.\"createdAt\""
    fi
    ;;

  *)
    die "укажите режим: dump <строка подключения> | load <файл>"
    ;;
esac
