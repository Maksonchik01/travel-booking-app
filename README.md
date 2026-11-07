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

## Джерела даних і ШІ

Усе вмикається в `.env` (див. `.env.example`); без ключів працюють mock-дані.

- Пошук: `FLIGHT_PROVIDERS=serpapi` + `SERPAPI_KEY` (живі ціни Google Flights, 250 запитів/міс).
- Календар: `CALENDAR_PROVIDERS=travelpayouts` + `TRAVELPAYOUTS_TOKEN`.
- Житло: поки лише mock-дані (`STAY_PROVIDERS=mock`, [ADR 0008](docs/adr/0008-stays-value-score.md)).
- Поїздка (`/trip`): переліт + житло на дати рейсу із загальною сумою ([ADR 0009](docs/adr/0009-trip-planner.md)).
- Алерти: кнопка «Стежити за ціною» на результатах; сповіщення в Telegram (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` — бот з @BotFather) і email (`SMTP_*`), без ключів — лише в лог. Воркер: `docker compose up worker` ([ADR 0010](docs/adr/0010-price-alerts.md)).
- Акаунти: логін/пароль і Google (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`; redirect URI `http://localhost:3000/api/auth/google/callback`), кабінет `/account` з історією й збереженими пошуками; бот — `/new`, `/list`, прив'язка з кабінету ([ADR 0011](docs/adr/0011-accounts-and-bot.md)).
- ШІ (чат-помічник у трьох режимах — квитки, житло, уся поїздка — історія розмов у браузері; пояснення результатів; резюме відгуків): `LLM_PROVIDER=deepseek` +
  `DEEPSEEK_API_KEY` ([ADR 0007](docs/adr/0007-llm-deepseek.md)). `LLM_PROVIDER=mock` —
  без ключа, `off` — без ШІ-блоків.
- Вартість ШІ: таблиця `llm_usage`, напр.
  `docker compose exec postgres psql -U tickets -c "select purpose, count(*), sum(cost_usd) from llm_usage group by 1"`.
- Якість розбору на 30 тестових запитах наживо (≈ $0.01): `uv run python scripts/eval_parser.py`.

## Перевірки

```bash
make check              # ruff, mypy, eslint, prettier, tsc, pytest, vitest
make test-integration   # readiness проти справжніх Postgres і Redis
make e2e                # Playwright smoke (API з mock-провайдером і mock-LLM, без витрат)
```

`make e2e` збирає web у той самий `.next`, тож запущений `npm run dev` після нього треба
перезапустити.

Ручна перевірка graceful degradation: зупини Redis (`docker compose stop redis`).
`/health/ready` має повернути 503 з `"redis": {"status": "error"}`, а сторінка
показати «Частково недоступно» без падіння.

Документація: [CLAUDE.md](CLAUDE.md), [docs/architecture.md](docs/architecture.md), [docs/adr/](docs/adr/).
