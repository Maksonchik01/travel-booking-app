# Tickets

Пошук подорожей з ШІ-аналізом: авіаквитки з кількох провайдерів, житло, оцінка
вигідності перельотів за балансом ціни, часу та кількості пересадок.

> Статус: етап 0 (каркас). Пошук з'явиться на наступних етапах.

## Вимоги

- Docker з Compose v2.24+: Docker Desktop або Colima. Для Colima:
  `brew install colima docker docker-compose docker-buildx`, далі
  `colima start --mount-inotify` (без `--mount-inotify` не працює hot reload API).
- [uv](https://docs.astral.sh/uv/) (сам встановить Python 3.12)
- Node.js 22.13+ і npm 11 (`npm install -g npm@11`)

## Швидкий старт

```bash
cp .env.example .env      # за потреби заповни ключі; без них усе теж стартує
make install
make up                   # Docker: postgres, redis, міграції, api, worker (hot reload); web — на хості
```

Увесь стек у Docker у prod-режимі (web як standalone-збірка): `make up-full`.
Web у dev навмисно запускається не в Docker: Turbopack-вотчер у Docker-VM на macOS
не бачить змін файлів, і документація Next 16 радить так не робити.

- Web: http://localhost:3000. На головній сторінці є картка «Стан сервісів».
- API: http://localhost:8000/docs
- Liveness: `curl localhost:8000/health`
- Readiness: `curl localhost:8000/health/ready`. Відповідає 200 і `ok`, коли Postgres і
  Redis доступні, інакше 503 і `degraded` з деталями.

## Локальна розробка без Docker для коду

```bash
make install
docker compose up -d postgres redis
make migrate
uv run uvicorn tickets_api.asgi:app --reload                           # API
uv run arq tickets_worker.settings.WorkerSettings                      # воркер
npm run dev -w @tickets/web                                            # web
```

## Перевірки

```bash
make check              # ruff, mypy, eslint, prettier, tsc, pytest, vitest
make test-integration   # readiness проти справжніх Postgres і Redis
make e2e                # Playwright smoke
```

Ручна перевірка graceful degradation: зупини Redis (`docker compose stop redis`).
`/health/ready` має повернути 503 з `"redis": {"status": "error"}`, а сторінка
показати «Частково недоступно» без падіння.

Документація: [CLAUDE.md](CLAUDE.md), [docs/architecture.md](docs/architecture.md), [docs/adr/](docs/adr/).
