# Tickets

Пошук подорожей з ШІ-аналізом: авіаквитки з кількох джерел, житло і вся поїздка разом.
Вигідність оцінює детермінований скоринг (ціна, час у дорозі, пересадки, ризики), а ШІ
розбирає запит звичайною мовою й пояснює готовий результат.

Ми нічого не продаємо: кнопка «До продавця» веде на сайт партнера (частина посилань
партнерські). Ціни орієнтовні, кешовані ціни завжди показані з віком.

Продакшн: **Vercel** (web) + **Render** (API, воркер, Redis) + **Supabase** (Postgres) —
[docs/deploy.md](docs/deploy.md).

## Можливості

- **Перельоти** — живі ціни Google Flights (SerpApi), календар цін (Travelpayouts), гнучкі дати,
  сусідні аеропорти, фільтри, «Наш вибір» за профілем «ціна / баланс / час».
- **Житло** — value-score з байєсівським рейтингом (поки mock-дані), резюме відгуків від ШІ.
- **Поїздка** — переліт × житло на дати рейсу із загальною сумою.
- **ШІ-помічник** — чат у трьох режимах; числа у відповіді звіряються з результатами пошуку.
- **Сповіщення про ціну** — Telegram-бот або email, лише коли ціна знижується.
- **Акаунти** — логін/пароль або Google, кабінет з історією й збереженими пошуками.
- **Юридичні сторінки** — `/terms`, `/privacy`, `/how-it-works`.

## Стек

| Частина | Технології |
|---|---|
| API (`apps/api`) | Python 3.12, FastAPI, SQLAlchemy async + asyncpg, Alembic, Redis |
| Воркер (`apps/worker`) | ARQ: перевірка цін для сповіщень, опитування Telegram-бота |
| Web (`apps/web`) | Next.js 16 (App Router, cacheComponents), Tailwind 4, shadcn/ui, next-intl |
| Типи (`packages/shared`) | TypeScript, згенеровані з OpenAPI |
| ШІ | DeepSeek через `LLMClient` (облік вартості в `llm_usage`) |

## Вимоги

- Docker з Compose v2.24+: Docker Desktop або Colima. Для Colima:
  `brew install colima docker docker-compose docker-buildx`, далі
  `colima start --mount-inotify` (без `--mount-inotify` не працює hot reload API).
- [uv](https://docs.astral.sh/uv/) (сам встановить Python 3.12).
- Node.js 22.13+ і npm 11 (`npm install -g npm@11`; npm 10 падає на peer-залежностях).

## Швидкий старт

```bash
cp .env.example .env      # без ключів усе стартує на mock-даних
make install              # uv sync + npm install
make up                   # Docker: postgres, redis, міграції, api, worker (hot reload); web — на хості
```

- Web: http://localhost:3000
- API і документація: http://localhost:8000/docs
- Стан: `curl localhost:8000/health/ready` — 200 і `ok`, коли Postgres і Redis доступні,
  інакше 503 і `degraded` з деталями.

Увесь стек у Docker як у проді (web — standalone-збірка): `make up-full`. Web у dev
навмисно не в Docker: Turbopack у Docker-VM на macOS не бачить змін файлів.

Без Docker для коду:

```bash
docker compose up -d postgres redis
make migrate
uv run uvicorn tickets_api.asgi:app --reload                  # API
uv run arq tickets_worker.settings.WorkerSettings             # воркер
npm run dev -w @tickets/web                                   # web
```

## Налаштування

Бекенд читає кореневий `.env` (повний перелік з поясненнями — [.env.example](.env.example)).
Web кореневий `.env` не читає: його змінні — в `apps/web/.env.local` локально і в
Environment Variables на Vercel.

| Що | Змінні | Без них |
|---|---|---|
| Пошук перельотів | `FLIGHT_PROVIDERS=serpapi`, `SERPAPI_KEY` | mock |
| Календар, сповіщення | `CALENDAR_PROVIDERS`/`ALERT_PROVIDERS=travelpayouts`, `TRAVELPAYOUTS_TOKEN` | mock |
| Партнерські посилання | `TRAVELPAYOUTS_MARKER` | звичайні посилання |
| ШІ | `LLM_PROVIDER=deepseek`, `DEEPSEEK_API_KEY` (`mock` — без ключа, `off` — вимкнено) | ШІ вимкнено |
| Telegram-бот | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` | повідомлення лише в лог |
| Email | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` | листи лише в лог |
| Вхід через Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | лише логін/пароль |
| Помилки в Sentry | `SENTRY_DSN` (API), `NEXT_PUBLIC_SENTRY_DSN` (web) | вимкнено |
| Ліміти на відвідувача | `INTERNAL_API_KEY` (той самий у web і API), `RATE_LIMIT_*_PER_HOUR` | ліміт на весь web-сервер |
| Web → API | `API_URL` (web) | `http://localhost:8000` |
| Контакт на `/privacy` | `CONTACT_EMAIL` (web) | рядка контакту немає |

Секрети — лише в `.env` / налаштуваннях хостингу, у репозиторії тільки `.env.example`.

**Квоти.** SerpApi безкоштовно дає 250 запитів на місяць: живі запити роби свідомо, тести
працюють на записаних фікстурах. Сповіщення ніколи не перевіряються через SerpApi.

## Моніторинг

- **Sentry** — помилки API, воркера й web без персональних даних (без cookies, заголовків,
  тіл запитів і query-параметрів).
- **Зведення для власника:**
  `curl -H "X-Internal-Key: $INTERNAL_API_KEY" localhost:8000/ops/summary` — квота SerpApi,
  виклики й вартість LLM, переходи на партнерів, записані ціни за добу, користувачі,
  активні підписки.
- **Логи** — JSON у проді (`LOG_JSON=true`); текст запитів користувача не логується.
- **Ліміти запитів** за годину на відвідувача: пошук 40, ШІ 30, вхід і підписки 20,
  переходи 200; понад ліміт — 429 і повідомлення в UI.

## Перевірки

```bash
make check              # ruff, mypy, eslint, prettier, tsc, pytest, vitest (як у CI)
make test-integration   # проти справжніх Postgres і Redis з compose
make e2e                # Playwright smoke (mock-провайдер і mock-LLM, без витрат)
```

`make e2e` збирає web у той самий `.next`, тож запущений `npm run dev` після нього треба
перезапустити.

Інше:

- Після зміни Pydantic-схем API: `make gen-types` (CI перевіряє актуальність типів).
- Нова міграція: `uv run alembic -c apps/api/alembic.ini revision --autogenerate -m "..."`.
  Нова таблиця вмикає RLS у своїй міграції (Supabase Data API), інакше падає
  `test_row_level_security`.
- Якість розбору запитів ШІ на 30 кейсах наживо (≈ $0.01): `uv run python scripts/eval_parser.py`.
- Graceful degradation вручну: `docker compose stop redis` — `/health/ready` дає 503, сайт
  показує «Частково недоступно», пошук працює без кешу.

## Відомі обмеження

- Житло — поки mock-дані: реальне джерело підключиться ще одним адаптером.
- Travelpayouts дає кешовані ціни й без деталей пересадок (показуємо «невідомо»).
- Безкоштовний API на Render засинає без запитів: перший запит після паузи — до хвилини.
- Лише українська мова інтерфейсу.

## Документація

- [CLAUDE.md](CLAUDE.md) — правила й інваріанти проєкту.
- [docs/architecture.md](docs/architecture.md) — архітектура.
- [docs/deploy.md](docs/deploy.md) — деплой (Supabase, Render, Vercel, моніторинг).
- [docs/adr/](docs/adr/) — архітектурні рішення (0001–0012).
