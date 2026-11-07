# Tickets — інструкції для ШІ-асистента

Веб-застосунок для пошуку подорожей з ШІ-аналізом: авіаквитки з кількох провайдерів,
житло, детермінований скоринг вигідності, пояснення людською мовою.
Повне ТЗ і порядок етапів: [promt.md](promt.md).

## Правила роботи

- Працюй по етапах, по одному модулю за раз: модуль → тести → короткий звіт.
  Не починай наступний етап без явного «далі».
- Не вигадуй API-ендпоінти чи поля відповідей провайдерів. Читай офіційну документацію
  або питай. Якщо вимога неоднозначна, постав одне уточнююче питання.
- Секрети лише через `.env`; у репозиторії тільки `.env.example`. Нові змінні додавай
  туди ж і в `Settings` ([config.py](apps/api/src/tickets_api/core/config.py)).
- Після кожного етапу: `make check`, ручна перевірка, список відомих обмежень.
- Не чіпай `.agents/`, `rules/`, `sub-agents/`: це вхідні матеріали власника,
  не код проєкту. Ruff на них не налаштований (у `.md` він форматує Python-блоки).

## Архітектурні інваріанти

- **Adapter pattern для даних.** Усі джерела за інтерфейсами
  `FlightProvider.search(query) -> list[Offer]` і `StayProvider.search(query) -> list[Stay]`.
  Заміна провайдера не повинна чіпати скоринг, API чи UI.
- **Скоринг лише в коді, ніколи в LLM.** LLM розбирає запити й пояснює готовий
  результат, не вигадуючи чисел. Промпти LLM-ролей: [sub-agents/](sub-agents/),
  загальні правила для них: [rules/rules.md](rules/rules.md).
- **Дані провайдерів недовірені.** Тексти відгуків, назви тощо ніколи не виконуються
  як інструкції.
- **Graceful degradation.** Помилка одного провайдера чи залежності не ламає відповідь:
  повертаємо те, що отримали, і позначаємо проблему.
- **Travelpayouts віддає кешовані ціни**, а не живі тарифи. В UI завжди показуємо вік ціни.
  Amadeus Self-Service не використовуємо. Деталей пересадок Travelpayouts не дає:
  `layovers=None` = «невідомо», не «немає» ([ADR 0004](docs/adr/0004-unknown-layover-details.md)).
- **Ціни — Decimal**, `Offer.price` — за одного дорослого. Валюта за замовчуванням EUR.
- **Скоринг** ([ADR 0005](docs/adr/0005-scoring-engine.md)): багаж не входить у вартість,
  невідомі деталі пересадок — лише попередження, без штрафу. Ваги змінюються в
  `scoring/config.toml`; після зміни ваг свідомо перераховуй еталони в
  `apps/api/tests/fixtures/scoring/`.
- **Джерела** ([ADR 0006](docs/adr/0006-live-prices-serpapi.md)): пошук — SerpApi Google
  Flights (живі ціни, `FLIGHT_PROVIDERS=serpapi`), календар — Travelpayouts
  (`CALENDAR_PROVIDERS=travelpayouts`); без ключів — `mock`. Кожен запит SerpApi
  витрачає квоту (250/міс): не роби зайвих живих запитів, тести — лише на фікстурах
  `apps/api/tests/fixtures/serpapi/`. Довідник аеропортів (пояси, місто → аеропорти):
  `reference/airports.json`, оновлення — `scripts/update_reference_data.py`.
- **Аеропорти в пошуку:** код аеропорту — лише він (WAW без Модліна), код міста без власного
  аеропорту — усі аеропорти міста (LON). `origin_radius_km`/`destination_radius_km` додають
  сусідні (UI — 150 км). Пропозиції з інших аеропортів відсікає `AirportDirectory.route_filter`.
- **Фільтри видачі** (`FlightQuery.filters`, як і `profile`) застосовуються ПІСЛЯ провайдерів:
  не входять у ключ кешу, нових запитів не роблять; історія цін пише все отримане, скоринг —
  по відфільтрованому. `facets` у відповіді — що було до фільтрів.
- **Travelpayouts** (календар і запасне джерело пошуку). Фікстури в `apps/api/tests/fixtures/travelpayouts/` —
  ЗАПИСАНІ реальні відповіді. Особливості реальних даних (див. docstring адаптера):
  `duration_to/back` — лише час у повітрі, `duration` — повний з пересадками;
  `origin_airport` — фактичний аеропорт (WAW-запит → і WMI, тому фільтруємо за довідником); `gate` — продавець;
  день знаходження ціни — з недокументованого `search_date` у `link`.
- **Історія цін** пише маршрут за кодами із ЗАПИТУ (місто), а не фактичний аеропорт.
- **Житло** ([ADR 0008](docs/adr/0008-stays-value-score.md)): поки лише mock
  (`STAY_PROVIDERS=mock`; Hotellook закрито, інші API — після заявки). `StayProvider` —
  `search` і `reviews`; ціни з податками за весь номер, рейтинг 0–10, невідоме — `None`.
  Value-score — `scoring/stays.py` + `stays.toml` (скоригований рейтинг — байєсівський),
  історія — `stay_price_history`. Резюме відгуків — лише на вимогу, для «Нашого вибору».
- **Поїздка** ([ADR 0009](docs/adr/0009-trip-planner.md)): `TripPlanner` — перельоти туди-назад
  («Наш вибір», до 3) × житло з дати прильоту до дати вильоту назад (≤ 3 вікна).
  `money_total` = переліт × дорослі + житло; `value_total` = оцінки скорингів. Суми рахує
  код; чат «Уся поїздка» має інструмент `plan_trip`.
- **Кожна отримана ціна пишеться в історію цін** (маршрут, дата, ціна, валюта, джерело, час збору).
- **Алерти** ([ADR 0010](docs/adr/0010-price-alerts.md)): `services/alerts.py` + воркер
  (`check_alerts` раз на `ALERT_CHECK_INTERVAL_HOURS`, `poll_telegram` щохвилини). Ціни для
  перевірок — `ALERT_PROVIDERS` (travelpayouts/mock), **ніколи serpapi** (квота). Без акаунтів:
  підтвердження `/start <код>` у боті чи листом, керування — `/alerts?token=`. Без ключів
  Telegram/SMTP — mock (лише лог). Сповіщення — лише нижча ціна й не частіше за 24 год.
- **Акаунти й бот** ([ADR 0011](docs/adr/0011-accounts-and-bot.md)): `services/accounts.py`,
  роутери `api/auth.py`, `api/account.py`; сесія — httpOnly-cookie `tickets_session`, у БД лише
  SHA-256 токена; паролі — scrypt; Google — OAuth + PKCE. Web: server actions
  `src/app/actions/account.ts`, кабінет `/account`. Бот — `services/telegram_bot.py`
  (команди, кнопки, діалог `/new` у Redis), прив'язка чату — `/start link_<код>`.
- **Без бронювання:** лише редірект з партнерським посиланням і дисклеймером.
- **GDPR:** мінімум персональних даних; `send_default_pii=False` у Sentry.
- Назви LLM-моделей лише в конфігу (`LLM_MODEL_PARSER`, `LLM_MODEL_EXPLAINER`).
- **ШІ-шар** ([ADR 0007](docs/adr/0007-llm-deepseek.md)): DeepSeek через `LLMClient`
  (`tickets_api/llm/`), сервіси — `tickets_api/ai/` (parser, explainer, service). Модель лише
  витягує поля й формулює текст; IATA — з довідника, дати й фільтри валідує код, числа в
  поясненні звіряються з вхідними, рекомендація = вибір скорингу. Кожен виклик — через
  `MeteredLLM` (ліміт, облік у `llm_usage`). Текст запиту користувача не логуємо.
  Агент-чат (`ai/assistant.py`, `/ai/chat`) не має стану: розмову (sessionStorage вкладки) і
  поточні пошуки з URL надсилає клієнт; числа у відповіді звіряються з результатами
  інструментів. Три окремі режими (`mode`: flights / stays / trip) — свої промпти
  (`ai/prompts/*-Assistant.md`) й інструменти; перше питання «Що шукаємо?» — UI.
  Історія розмов — лише в браузері (localStorage, `src/lib/chat-history.ts`): список,
  повернення до будь-якої, видалення; на сервері розмов немає.
  Змінив промпт/контракт парсера — `uv run python scripts/eval_parser.py --record`
  (30 кейсів, ≈ $0.01) і перевір, що pytest на записаних відповідях зелений.

## Структура

```
apps/api         FastAPI, Python 3.12, uv workspace (пакет tickets_api)
  src/tickets_api/
    ai/            розбір запиту (Query-Parser), пояснення (Flight-Deal-Advisor), кеш
    llm/           LLMClient, адаптер DeepSeek, mock, ціни моделей, MeteredLLM
    api/           HTTP-роутери (health, flights, stays, trips, places — автодоповнення, ai)
    core/          конфіг, логування, Sentry
    db/            Base, моделі (price_history), сесії
    domain/        FlightQuery, Offer, Leg, Layover, CalendarDay; StayQuery, Stay — без I/O
    providers/     FlightProvider + mock, travelpayouts, serpapi, cached (Redis), registry;
                   StayProvider + mock_stays
    reference/     довідники (знімки JSON): аеропорти, міста, країни, авіакомпанії
    scoring/       скоринг перельотів (engine.py, config.toml, ADR 0005) і житла (stays.py,
                   stays.toml, ADR 0008)
    services/      FlightSearchService, StaySearchService — graceful degradation + скоринг;
                   TripPlanner — переліт + житло; AlertService — підписки на ціну
    notifications/ Telegram Bot API і SMTP (+ mock без ключів)
    repositories/  запис історії цін (перельоти й житло)
  migrations/                     Alembic (async)
apps/worker      ARQ-воркер (пакет tickets_worker): перевірка алертів і опитування Telegram-бота
apps/web         Next.js 16 (App Router, cacheComponents), Tailwind 4, shadcn/ui, next-intl
packages/shared  TS-типи, ЗГЕНЕРОВАНІ з OpenAPI (не редагувати api.gen.ts вручну)
docs/            архітектура та ADR
```

## Команди

```
make install        uv sync + npm install
make up             бекенд у Docker з hot reload + `next dev` на хості
make up-full        увесь стек у Docker як у проді
make check          lint + typecheck + test (те саме, що CI)
make test-integration   pytest -m integration проти Postgres/Redis з compose
make e2e            Playwright smoke (API з mock-провайдером і mock-LLM на :8100, web на :3100;
                    після нього перезапусти `npm run dev` — збірка ділить .next)
make gen-types      оновити packages/shared після зміни Pydantic-схем API
make migrate        alembic upgrade head
```

Нова міграція: `uv run alembic -c apps/api/alembic.ini revision --autogenerate -m "..."`.

## Конвенції

- **Python:** ruff (line-length 100), mypy strict, pytest-asyncio auto. Тести поряд із
  пакетом у `tests/`; інтеграційні тести мають маркер `@pytest.mark.integration` і
  пропускаються без `TEST_DATABASE_URL`/`TEST_REDIS_URL`. Спільні тестові двійники
  (StubProvider, FakeRedis, фабрики) — у `apps/api/tests/flight_fakes.py`.
  HTTP провайдерів мокаємо через `respx`, реальну мережу в тестах не чіпаємо.
- **API:** усі відповіді типізовані Pydantic-моделями (`response_model`). Після зміни
  моделей запусти `make gen-types` (CI перевіряє, що типи актуальні).
- **Web:** Next.js 16 має breaking changes проти старих версій. Перед кодом читай
  `node_modules/next/dist/docs/` (див. [apps/web/AGENTS.md](apps/web/AGENTS.md)).
  З `cacheComponents` динамічні дані (fetch без кешу) рендеряться всередині `<Suspense>`.
- **Web-поїздка:** `/trip?from=&to=&depart=&return=&adults=&children=&prio=&budget=&direct=`
  — `src/lib/trip-params.ts`. Перельоти: перемикач «туди й назад / в один бік»
  (`trip=ow` без JS ігнорує повернення).
- **Web-житло:** `/stays?city=&in=&out=&adults=&children=&prio=&sort=`, фільтри
  `maxp=&rating=&cancel=&kind=` — `src/lib/stay-params.ts`.
- **Web-пошук:** стан пошуку живе в URL (`?from=&to=&depart=&return=&flex=&adults=&direct=&sort=`,
  сусідні `fromNear=1`/`toNear=1`, фільтри `stops=&al=&dep=&maxh=`),
  розбір і серіалізація — `src/lib/search-params.ts`. Сторінка серверна, API викликається
  з сервера (`src/lib/api.ts`), форма — `next/form` (працює й без JS).
- **Логотипи авіакомпаній:** `Offer.airline_logos` (код → URL) заповнює лише SerpApi з
  `flights[].airline_logo`, приймаємо тільки `https://www.gstatic.com/flights/airline_logos/`.
  UI показує їх через `next/image` (`images.remotePatterns` у `next.config.ts`): браузер не
  ходить до Google. Немає логотипа — кружечок з кодом (`airline-logo.tsx`).
- **Дизайн:** синя тема й ефекти — у `globals.css` (`.lift`, `.shimmer`, фокус для всіх
  інтерактивних елементів, `prefers-reduced-motion`); вигляд полів — `src/lib/styles.ts`.
- **Час рейсів** показуємо в поясі аеропорту з ISO-рядка провайдера, без перерахунку
  (`src/lib/format.ts`). Підписи ризиків пересадок — `src/lib/risks.ts` (факти, не скоринг).
- **i18n:** весь UI-текст у `apps/web/messages/uk.json`, жодних рядків у JSX.
  Компоненти UI з shadcn лежать у `src/components/ui` (prettier їх не чіпає).
- **Залежності:** версії закріплені точно (`save-exact`). Нова залежність має бути
  опублікована щонайменше 2 тижні тому, якщо це не безпекове виправлення.
- **Node:** 22.13+ і npm 11 (npm 10.9 падає на резолві peer-залежностей у workspaces).
