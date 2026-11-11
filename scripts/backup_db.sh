#!/usr/bin/env bash
# Логічна резервна копія продакшн-бази Supabase (V3, етап 11; docs/deploy.md «Відновлення»).
#
# Supabase Free автоматичних копій не робить — лише власні дампи. Копія містить ПЕРСОНАЛЬНІ
# ДАНІ користувачів (акаунти, email, збережені поїздки): зберігайте її лише в зашифрованому
# місці, не комітьте (backups/ — у .gitignore) і видаляйте старі.
#
#   scripts/backup_db.sh            # адреса — SUPABASE_DATABASE_URL з .env (лише читання бази)
#   BACKUP_DIR=~/SkyPack-backups scripts/backup_db.sh   # тека поза репозиторієм
#
# pg_dump 17 (як сервер Supabase) — з образу postgres:17-alpine, локальних утиліт не треба.
set -euo pipefail
cd "$(dirname "$0")/.."

url="${SUPABASE_DATABASE_URL:-}"
if [[ -z "$url" && -f .env ]]; then
  url="$(grep -E '^SUPABASE_DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
fi
if [[ -z "$url" ]]; then
  echo "SUPABASE_DATABASE_URL не задано (.env чи змінна оточення)" >&2
  exit 1
fi
dir="${BACKUP_DIR:-backups}"
mkdir -p "$dir"
chmod 700 "$dir"
out="$dir/skypack-$(date -u +%Y%m%dT%H%MZ).dump"
umask 077
# Адресу розбираємо на PG*-змінні: у паролі можуть бути символи на кшталт «%», які libpq
# у рядку підключення читає як кодування (і друкує уривок у помилці). Пароль — лише в
# змінній оточення контейнера, не в аргументах (ps, історія) і не в повідомленнях.
eval "$(URL="$url" python3 - <<'PY'
import os, shlex
from urllib.parse import unquote, urlsplit
u = urlsplit(os.environ["URL"].replace("postgresql+asyncpg://", "postgresql://", 1))
for key, value in {
    "PGHOST": u.hostname or "",
    "PGPORT": str(u.port or 5432),
    "PGUSER": unquote(u.username or ""),
    "PGPASSWORD": unquote(u.password or ""),
    "PGDATABASE": (u.path or "/postgres").lstrip("/") or "postgres",
}.items():
    print(f"export {key}={shlex.quote(value)}")
PY
)"
docker run --rm -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE postgres:17-alpine \
  pg_dump --format=custom --no-owner --no-privileges > "$out"
unset PGPASSWORD
echo "Копія: $out ($(du -h "$out" | cut -f1)). Перевірка: pg_restore --list $out | head"
