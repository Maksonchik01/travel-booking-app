#!/usr/bin/env bash
# Логічна резервна копія продакшн-бази Supabase (V3, етап 11; docs/deploy.md «Відновлення»).
#
# Supabase Free автоматичних копій не робить — лише власні дампи. Копія містить ПЕРСОНАЛЬНІ
# ДАНІ користувачів (акаунти, email, збережені поїздки): зберігайте її лише в зашифрованому
# місці, не комітьте (backups/ — у .gitignore) і видаляйте старі.
#
#   scripts/backup_db.sh            # адреса — SUPABASE_DATABASE_URL з .env (лише читання бази)
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
url="${url/postgresql+asyncpg:\/\//postgresql://}"

mkdir -p backups
chmod 700 backups
out="backups/skypack-$(date -u +%Y%m%dT%H%MZ).dump"
umask 077
# Адреса з паролем — лише через змінну оточення контейнера, не в аргументах (ps, історія).
docker run --rm -e "PGDUMP_URL=$url" postgres:17-alpine \
  sh -c 'pg_dump "$PGDUMP_URL" --format=custom --no-owner --no-privileges' > "$out"
echo "Копія: $out ($(du -h "$out" | cut -f1)). Перевірка: pg_restore --list $out | head"
