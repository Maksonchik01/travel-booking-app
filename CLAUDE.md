# Tickets — інструкції для ШІ-асистента

SkyPack — веб-застосунок для пошуку подорожей з ШІ-аналізом (у коді — `tickets_*`): авіаквитки з кількох провайдерів,
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
- **Ціни — Decimal**, `Offer.price` — за весь склад пасажирів і клас запиту ([ADR 0013](docs/adr/0013-party-pricing.md)):
  дорослий тариф на дітей не множимо; джерело, що не вміє склад/клас, кидає
  `ProviderUnsupportedError` (статус `unsupported`). Скоринг множить штрафи часу/пересадок/ризиків
  на `Passengers.seated`; історія цін пише `party` і `cabin`. Валюта за замовчуванням EUR.
- **Гнучкі дати** ([ADR 0016](docs/adr/0016-flexible-dates.md)): `flex_days` / `departure_until`;
  кандидати з кешованого календарного джерела → `check_dates` для живого (бюджет ділиться);
  `FlightSearchResult.date_options` з `verified`. URL: `flex=1|3|7|month|range&until=`;
  ночі (2b) `nmin=&nmax=` — від дати прильоту (`stay_nights`), фільтр і для живих пропозицій.
  Календар `cal=YYYY-MM`; матриця `GET /flights/matrix` — лише кешовані джерела, без живих запитів.
- **Продавці** ([ADR 0017](docs/adr/0017-sellers-and-price-check.md)): `Offer.price_status`/`cabin`/
  `booking_ref`; однаковий рейс — `groups` (одна картка); `POST /flights/sellers` — на вимогу
  (1 запит SerpApi, кеш 30 хв), це й перевірка ціни перед переходом; без неї — «підтверджує продавець».
- **Валюта** ([ADR 0015](docs/adr/0015-currency-ecb-rates.md)): EUR/USD/GBP/PLN, ціни — від джерела;
  ваги скорингу переводяться за курсом ЄЦБ (`providers/fx.py`, кеш у Redis), без курсу — не оцінюємо.
- **Багаж** ([ADR 0014](docs/adr/0014-baggage-final-price.md)): `FlightQuery.baggage` (не в запит
  джерела), `Offer.baggage` (None — невідомо), `scoring/baggage.py` → `FlightSearchResult.baggage`;
  «найдешевший» — серед відомих кінцевих вартостей, якщо такі є.
- **Скоринг** ([ADR 0005](docs/adr/0005-scoring-engine.md), [ADR 0031](docs/adr/0031-filter-then-rank.md)):
  спершу обов'язкові вимоги (`requirement_violations`: фільтри, `direct_only`, багаж `not_available`
  → `excluded`), потім ранжування; в оцінці — відома доплата за обраний багаж, нічний приліт, зміна
  аеропорту (з сегментів), м'які уподобання профілю (`FlightQuery.preferences`, не фільтр);
  невідоме — лише попередження, без штрафу. «Чому цей варіант?» — `reasons` (код, не LLM) у
  `OfferScore`, `StayScore` (бажані зручності — `StayQuery.preferences`) і `TripCombo` (там же
  `full_nights`, `travel_min`, `waiting_min`); веб — `why-list.tsx`. Ваги змінюються в
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
- **Тарифи продавців житла й обране** ([ADR 0020](docs/adr/0020-stay-rates-and-favorites.md)):
  `StayRate` + `StayRateSource.rates`, `POST /stays/rates` — групи лише однакових умов (номер, ліжко,
  харчування, скасування), «найдешевший» — серед відомих кінцевих сум; `Stay.sellers` (None —
  порівняння немає). Обране: гість — localStorage, акаунт — таблиця `favorites` (`/account/favorites`),
  знімок з історичною ціною; сторінка `/favorites`. «Додати до поїздки» — `TripQuery.stay` (`stay=`).
- **Поїздка** ([ADR 0009](docs/adr/0009-trip-planner.md), [ADR 0021](docs/adr/0021-trip-builder-scenarios.md)):
  `TripPlanner` — кандидати перельотів (до 6, без тарифів без потрібного багажу) × житло з місцевої
  дати ПРИЛЬОТУ до дати вильоту назад (≤ 3 вікна, `stay_filters` — обов'язкові). Дати: `return_date`
  або `min_nights`/`max_nights` + `flex_days`/`departure_until`. `TripCosts`: підтверджене / орієнтовне /
  невідоме (`money_total` — лише відоме); сценарії Економ / Оптимальний / Комфорт (`cheapest` /
  `best_value` / `comfort`, `over_budget`), час прильоту — `scoring/trip.toml`. Житло комбінації —
  `stays[stay_index]`. URL: `until=&nmin=&nmax=&near=&bag=&cabin=&rating=&cancel=&bfast=&dist=&xl=&xa=`.
  «Ваша поїздка» (8b): вибір у URL (`flight=`, `stay=` → `selected`, `flight_options`, `stay_options`),
  заміна одного компонента зберігає інший, якщо сумісний; «Повернути» — стек у sessionStorage;
  «Знайти дешевший варіант» — `POST /trips/cheaper` (±3 дні, ті самі ночі, сусідні аеропорти, той
  самий тип житла; лише на вимогу — це ще пошук перельотів).
  8c: порівняння до 3 (`trip-compare.tsx`, sessionStorage) за знімком `TripSnapshot`; збережені поїздки —
  запит + знімок з історичними цінами: гість — localStorage, акаунт — таблиця `saved_trips`
  (`/account/trips`), сторінка `/trips`; редагування — `saved=` в URL; «Оновити ціни» — `POST /trips/refresh`.
  Суми рахує код; чат «Уся поїздка» має інструмент `plan_trip`.
- **Запити до джерел** ([ADR 0034](docs/adr/0034-provider-resilience-and-freshness.md)): HTTP — лише через
  `providers/gate.py` `ProviderGate` (ліміт одночасних, повтор 502–504/обриву з паузою; 429/4xx —
  ні; SerpApi тайм-аут не повторює). Однакові запити — один виклик (`CachedFlightProvider`: у процесі
  й замок Redis між процесами); ключ — `search_cache_payload` (поле лише для видачі — у
  `CACHE_EXCLUDED`). Свіжість ціни — `domain/freshness.py` → `freshness` у відповідях пошуку
  (live / cached / approximate / needs_recheck), UI — `price-freshness.tsx`. Логи маскує
  `redact_secrets`; клієнтський код — без серверних модулів (`server-boundary.test.ts`).
- **Кожна отримана ціна пишеться в історію цін** (маршрут, дата, ціна, валюта, джерело, час збору).
- **Алерти** ([ADR 0010](docs/adr/0010-price-alerts.md)): `services/alerts.py` + воркер
  (`check_alerts` раз на `ALERT_CHECK_INTERVAL_HOURS`, `poll_telegram` щохвилини). Ціни для
  перевірок — `ALERT_PROVIDERS` (travelpayouts/mock), **ніколи serpapi** (квота). Без акаунтів:
  підтвердження `/start <код>` у боті чи листом, керування — `/alerts?token=`. Без ключів
  Telegram/SMTP — mock (лише лог). Сповіщення — лише нижча ціна й не частіше за 24 год.
  Підписки акаунта ще й за `users.notify_prefs` (канали, частота, мін. зниження, тихі години,
  категорії — `domain/notify.py`, причина затримки — подія `held`; [ADR 0025](docs/adr/0025-notifications-and-sessions.md)).
  Типи (`alerts.kind`, [ADR 0026](docs/adr/0026-alert-kinds-and-conditions.md)): flight / flex (період,
  ночі, вихідні) / stay / trip — житло й поїздка лише з реальним джерелом житла (`channels.kinds`);
  умови below_price / drop_amount / drop_percent (від `baseline_price`) / below_typical,
  повтор — лише при новій істотній зміні (`triggered`). Лише дорослі в економі, ціна — за всіх.
  Керування ([ADR 0027](docs/adr/0027-alert-management-and-limits.md)): за токеном — пауза /
  відновлення / редагування / вимкнення / видалення / історія (`alert-manage.tsx`, і в кабінеті);
  перевірка — замок у Redis, однакові пошуки — один запит, `ALERT_MAX_SEARCHES_PER_RUN`,
  `ALERT_MAX_ACTIVE_PER_OWNER`, дати ≤ року, журнал `checked` — 30 днів.
- **Синхронізація модулів** ([ADR 0032](docs/adr/0032-module-sync.md)): стан — URL; переходи «→ поїздка»
  лише через `lib/trip-params.ts` (`tripFromStay`, `tripFromFlight` → `flight=`/`stay=`), без логіки в
  компонентах. Збережена поїздка → `/trip?…#price-alert`. Кабінет → нові пошуки: `tripDefaults`,
  уподобання (`*Preferences`), а чат — через `/api/ai/chat` (аеропорт, валюта, уподобання з акаунта;
  уподобання моделі не передаються).
- **Кабінет** ([ADR 0023](docs/adr/0023-cabinet-sections.md)): розділи — окремі сторінки `/account`
  (огляд), `/account/{favorites,trips,history,alerts,settings,security}` в оболонці
  `components/account-shell.tsx`. Обране — три категорії (`favorites.kind`: stay / flight / trip,
  `lib/favorites.ts`); поїздки — статуси draft / planned / archived (лише `PATCH`, «заброньованої»
  немає).
- **Акаунти й бот** ([ADR 0011](docs/adr/0011-accounts-and-bot.md)): `services/accounts.py`,
  роутери `api/auth.py`, `api/account.py`; сесія — httpOnly-cookie `tickets_session`, у БД лише
  SHA-256 токена; паролі — scrypt; Google — OAuth + PKCE. Web: server actions
  `src/app/actions/account.ts`, кабінет `/account`. Бот — `services/telegram_bot.py`
  (команди, кнопки, діалог `/new` у Redis), прив'язка чату — `/start link_<код>`.
  Сесії: `device` («браузер · ОС» з `X-Client-Device`, без IP) і `last_seen_at`; список і
  завершення — `/account/sessions` (ADR 0025).
- **Продакшн:** Vercel (web) + Render (API, воркер, Redis) + Supabase Postgres
  ([deploy.md](docs/deploy.md), [ADR 0012](docs/adr/0012-supabase-postgres.md)). Кожна таблиця —
  з RLS (Supabase Data API): нова таблиця вмикає його у своїй міграції, інакше падає
  `test_row_level_security`. Цілісність ([ADR 0033](docs/adr/0033-database-integrity.md)): `user_id` —
  ключ до `users` з каскадом (`_user_fk()`), переліки — CHECK з тих самих Literal (`one_of`), видалення
  акаунта — лише `users` (решту прибирає БД); перевіряє `test_db_integrity`. Прострочені сесії й токени
  чистить воркер (`prune_database`); у Data API ролей `anon`/`authenticated` прав на таблиці немає.
- **Без бронювання:** лише редірект з партнерським посиланням і дисклеймером. «Забронювати» веде
  на веб-маршрут `/out` (`src/app/out/route.ts`): редирект лише на префікси з
  `src/lib/outbound.ts` (новий провайдер з посиланнями — новий префікс), клік пишеться після
  відповіді (`after`) у `outbound_clicks` через `POST /outbound/clicks` — без користувача й IP.
  Marker Travelpayouts (`TRAVELPAYOUTS_MARKER`) додає адаптер.
- **Юридичні сторінки** `/terms`, `/privacy`, `/how-it-works` (`components/legal-page.tsx`,
  тексти — `legal.*` в uk.json, посилання — у футері). Вони описують ФАКТИЧНУ роботу: змінив
  збір даних, cookies, сховище браузера, провайдерів чи формулу скорингу — онови текст і
  `LEGAL_UPDATED`. Контакт — `CONTACT_EMAIL` (env вебу).
- **Ліміти запитів** (`core/rate_limit.py`, Redis, вікно — година): `search`, `ai`, `auth`, `clicks`
  через `dependencies=[Depends(rate_limit(...))]`. IP відвідувача веб передає в `X-Client-IP`
  (`src/lib/client-ip.ts`), API вірить йому лише з `X-Internal-Key` = `INTERNAL_API_KEY`.
  Redis недоступний — пропускаємо. 429 → `reason: "rate_limited"` / `authErrors.rate_limited`.
- **Моніторинг:** Sentry в API (`core/sentry.py`) і вебі (`src/instrumentation*.ts`,
  `src/lib/sentry-options.ts`, `app/global-error.tsx`) — лише помилки, без PII (cookies, заголовки,
  тіла, query вимкнені). `GET /ops/summary` (`services/ops.py`) — агрегати для власника за
  `X-Internal-Key`; лише лічильники, без email/токенів; кожна секція падає окремо.
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
  Уточнення — патчем (`refine_flights`/`refine_stays`, `ai/refine.py`): модель дає лише зміни,
  код накладає й рахує відносні; команди поїздки (`change_trip`, `undo_trip`, `compare_trips`,
  `save_trip`) працюють з `current_trip`/`previous_trip` від вебу, вибір рейсу/житла — кодом
  (`pick_flight`/`pick_stay`) ([ADR 0022](docs/adr/0022-assistant-refine-and-trip-commands.md)).
  Картки результатів у чаті — `ChatReply.cards` (`ai/cards.py`, будує код; веб — `chat-cards.tsx`):
  «Відкрити в планувальнику» несе запит з вибором; «Оптимізувати з ШІ» — подія `ai:open`
  (`lib/ai-events.ts`), обробники звіряють `usePathname()` (приховані сторінки змонтовані).
  Історія розмов — у браузері (localStorage, `src/lib/chat-history.ts`): список, повернення,
  перейменування, видалення; в акаунті — ЛИШЕ за згодою (`users.chat_sync`, таблиця
  `chat_conversations`, `/account/chats`; вимкнення видаляє з сервера; ADR 0022).
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
- **Режими пошуку** ([ADR 0028](docs/adr/0028-home-and-search-modes.md)): `search-modes.tsx` над карткою
  `/`, `/stays`, `/trip` — Авіаквитки / Житло / Поїздка / ШІ-пошук; спільне (куди, дати, люди) —
  `lib/search-modes.ts` з поточної форми (`form[data-search-form]`), неповне — чернетка у формі.
  Бренд у UI — SkyPack (внутрішні імена `tickets_*` / `tickets.*` не змінюємо).
- **Web-поїздка:** `/trip?from=&to=&depart=&return=&adults=&children=&prio=&budget=&direct=`
  — `src/lib/trip-params.ts`. Перельоти: перемикач «туди й назад / в один бік»
  (`trip=ow` без JS ігнорує повернення).
- **Web-житло:** `/stays?city=&in=&out=&adults=&children=&ages=&rooms=&prio=&sort=`, фільтри
  `minp=&maxp=&mint=&maxt=&rating=&cancel=&bfast=&noprepay=&payprop=&kind=&am=&beds=&dist=&district=&near=&nearap=&radius=`
  — `src/lib/stay-params.ts`; фільтр видно лише за `facets.available` ([ADR 0018](docs/adr/0018-stay-filters.md)).
  Карта (`view=map`, `bbox=`) — MapLibre + OpenFreeMap ([ADR 0019](docs/adr/0019-stay-map.md)); воркер копіює
  `apps/web/scripts/copy-maplibre-worker.mjs` (predev/prebuild).
- **Web-пошук:** стан пошуку живе в URL (`?from=&to=&depart=&return=&flex=&adults=&children=&lap=&seat=&cabin=&bag=&cur=&direct=&sort=`,
  сусідні `fromNear=1`/`toNear=1`, фільтри `stops=&al=&xal=&dep=&deph=&arr=&arrh=&rdep=&rdeph=&rarr=&rarrh=&maxh=&maxlay=&minlay=&minself=&maxp=&maxt=`;
  частини доби — ранок 05–12, день 12–17, вечір 17–22, ніч 22–05 за місцевим часом аеропорту),
  панель фільтрів — основні на виду, решта в «Розширених фільтрах» (`result-filters.tsx`);
  «Зберегти налаштування» — `src/lib/saved-filters.ts` (localStorage) + `users.flight_filters`
  (`PUT /account/flight-filters`, лише ключі фільтрів); новий пошук додає їх з позначкою у формі,
  розбір і серіалізація — `src/lib/search-params.ts`. Сторінка серверна, API викликається
  з сервера (`src/lib/api.ts`), форма — `next/form` (працює й без JS).
- **Профіль** (ADR 0024): `PUT /account/preferences` (мова, валюта, країна, аеропорти — коди з
  довідника), фото — власне (`user_avatars`, ≤ 300 КБ, PNG/JPEG/WebP за сигнатурою, віддає
  `/api/account/avatar`) → Google (`google_picture`) → ініціали (`user-avatar.tsx`). Налаштування
  пошуку `users.search_prefs` (`lib/search-prefs.ts`) — початкові значення НОВОГО пошуку й
  фільтри з позначкою (`params-toggle.tsx`); профіль від зміни у формі не змінюється.
- **Логотипи авіакомпаній:** `Offer.airline_logos` (код → URL) заповнює лише SerpApi з
  `flights[].airline_logo`, приймаємо тільки `https://www.gstatic.com/flights/airline_logos/`.
  UI показує їх через `next/image` (`images.remotePatterns` у `next.config.ts`): браузер не
  ходить до Google. Немає логотипа — кружечок з кодом (`airline-logo.tsx`).
- **Стани й фільтри** ([ADR 0029](docs/adr/0029-ui-states-filters-mobile.md)): запити браузера — через
  `lib/client-fetch.ts` (тайм-аут), помилка — `RetryNotice` / `PageNotice` з повтором; фільтри —
  `filter-shell.tsx` (панель ≥ lg, вікно на телефоні). Нова сторінка — додай її в `e2e/mobile.spec.ts`.
- **Доступність** ([ADR 0030](docs/adr/0030-accessibility-and-design-tokens.md)): `e2e/a11y.spec.ts` (axe, WCAG 2.1
  AA, світла й темна тема, телефон) — нова сторінка йде в його `PAGES`; статуси — токени `success` /
  `warning` (`text-success`, `bg-warning/10`), не сирі `emerald-*` / `amber-*`; іконка без тексту —
  з `aria-label`; `main` — `id="main"` для «Перейти до вмісту».
- **Продуктивність** ([ADR 0035](docs/adr/0035-frontend-performance.md)): у браузер — лише клієнтські
  переклади (`lib/client-messages.ts`, новий розділ — у `CLIENT_NAMESPACES`, перевіряє тест);
  Sentry у браузері — ліниво (`lib/sentry-client.ts`, `reportError`); важке для одного режиму —
  через `next/dynamic` (`stay-map-lazy.tsx`); повторні серверні виклики в одному рендері —
  `cache()` (`fetchAIStatus`, `currentAccount`).
- **Дизайн:** синя тема й ефекти — у `globals.css` (`.lift`, `.shimmer`, фокус для всіх
  інтерактивних елементів, `prefers-reduced-motion`); вигляд полів — `src/lib/styles.ts`.
- **Картка рейсу** (`offer-card.tsx`): позначки лише з реальних параметрів (вибір скорингу, «Прямий
  рейс», «Самостійна пересадка» — `self_transfer === true`), «Деталі маршруту» (сегменти, зміна
  аеропорту з сегментів, повторна реєстрація багажу — лише коли `self_transfer` відомий);
  порівняння до 3 — `compare.tsx` (sessionStorage вкладки).
- **Час рейсів** показуємо в поясі аеропорту з ISO-рядка провайдера, без перерахунку
  (`src/lib/format.ts`). Підписи ризиків пересадок — `src/lib/risks.ts` (факти, не скоринг).
- **i18n** ([ADR 0024](docs/adr/0024-i18n-and-profile.md)): мови en (за замовчуванням) / uk / ru,
  весь UI-текст у `apps/web/messages/{en,uk,ru}.json` (однакові ключі), жодних рядків у JSX.
  Сторінки — у `app/[locale]/` (кореневий параметр, `next/root-params`); `src/proxy.ts` переписує
  шлях за cookie `NEXT_LOCALE` без префікса в URL; перемикач — `language-switcher.tsx`
  (з акаунтом пише й `users.locale`, після входу cookie — з профілю). Новий текст — у всі три файли.
  Компоненти UI з shadcn лежать у `src/components/ui` (prettier їх не чіпає).
- **Залежності:** версії закріплені точно (`save-exact`). Нова залежність має бути
  опублікована щонайменше 2 тижні тому, якщо це не безпекове виправлення.
- **Node:** 22.13+ і npm 11 (npm 10.9 падає на резолві peer-залежностей у workspaces).
