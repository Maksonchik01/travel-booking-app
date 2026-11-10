# Тестування: матриця покриття

Модуль 21. Кожен сценарій з ТЗ і тести, що його перевіряють.

**Рівні:**
- **API** — `apps/api/tests`, pytest;
- **INT** — інтеграційні, проти Postgres і Redis (`make test-integration`);
- **WEB** — `apps/web/src/**/*.test.ts(x)`, vitest;
- **E2E** — `apps/web/e2e`, Playwright: mock-джерела й mock-LLM, без живих запитів.

**Як запускати:**
- `make check` — lint, типи, API і WEB;
- `TEST_DATABASE_URL=… TEST_REDIS_URL=… uv run pytest -m integration` — INT;
- `make e2e` — E2E (після нього перезапусти `npm run dev`).

Живі джерела (SerpApi — квота 250 на місяць) у тестах не використовуються: лише записані фікстури (`tests/fixtures/serpapi`, `travelpayouts`, `ecb`).

## 21.1 Авіаквитки

| Сценарій | Тести |
|---|---|
| One-way | E2E «пошук: підказки міст → результати…» (в один бік); API `test_serpapi_provider` (type=2), `test_mock_provider` |
| Round-trip | E2E «картка…», «гнучкі дати…», «матриця…»; API `test_serpapi_provider` (повернення через departure_token) |
| Категорії пасажирів | E2E «сім'я з багажем»; API `test_flight_search_service::test_source_that_cannot_price_the_party…`, `test_domain_flights` (Passengers), WEB `passenger-picker.test` |
| Гнучкі дати | E2E «гнучкі дати…», «3–5 ночей у грудні…»; API `test_flexible_dates` |
| Сусідні аеропорти | API `test_airports` (route_filter, радіус), `test_provider_resilience` (ключ кешу); WEB `search-params.test`, `empty-suggestions.test` |
| Пересадки | E2E «пошук…» («Лише прямі», приховані пересадки); API `test_offer_filters`, `test_flight_ranking` (direct_only — обов'язкова вимога), `test_scoring_engine` |
| Багаж | E2E «сім'я з багажем»; API `test_baggage`, `test_flight_ranking` (тариф без багажу відсіюється, доплата в оцінці); WEB `offer-card.test` |
| Цінові фільтри | E2E «розширені фільтри…», «порожні результати…»; API `test_offer_filters` (max_price / max_total_price) |
| Сортування | E2E «модуль 21.1: сортування — «Швидші»…»; WEB `sort.test` (ціна / час / виліт / оцінка, невідоме — в кінці); API `test_multi_source` (порівнювана вартість: валюта, багаж, стара ціна — в кінці) |
| Порівняння | E2E «картка: … порівняння трьох варіантів»; WEB `compare.test` |
| Відкриття пропозицій | E2E «картка: … деталі маршруту», «модуль 15: рейс → «Додати до поїздки»»; WEB `seller-offers.test`, `outbound.test`; `app/out/route.test` |

## 22 Кілька джерел перельотів

| Сценарій | Тести |
|---|---|
| Кілька джерел в одному пошуку | API `test_multi_source::test_same_flight_from_all_sources…` (кожне джерело — раз, одна картка) |
| Гнучкі дати з кешованим пошуковим джерелом | API `test_multi_source::test_flexible_search_asks_cached…`, `test_flexible_dates` (жива ціна дати — перевірена) |
| Відмова джерела | API `test_multi_source::test_one_failed_source…` |
| Охоплення для діагностики | API `test_multi_source::test_coverage_counters…`, `…log_has_no_route…`; `test_ops` |
| Продавець на картці | WEB `offer-card.test` (найдешевший продавець і кількість) |
| Продавці найкращого рейсу без кнопки | WEB `seller-offers.test` (autoCheck — один раз; невдача — лишається кнопка) |

Контрольні живі пошуки (листопад 2026, 10 запитів SerpApi): AMS→WAW в один бік і туди-назад, WAW→BCN, WAW→LIS для сім'ї з багажем, WAW→BCN ±3 дні; продавці KL1319 і W6 1475 — див. ADR 0041.

## 21.2 Житло

| Сценарій | Тести |
|---|---|
| Пошук за містом | E2E «житло: пошук → наш вибір…»; API `test_stays` |
| Дати | API `test_stays` (ночі, check_out > check_in); WEB `stay-params.test` |
| Кількість гостей | API `test_stays` (Guests, кімнати); WEB `stay-params.test` |
| Фільтри | E2E «житло: … фільтр»; API `test_stay_filters`; WEB `stay-filters.test` |
| Карта | E2E «карта житла…», `mobile.spec` (карта); WEB `stay-map.test` |
| Вибір об'єкта | E2E «житло: детальніше…»; WEB `stay-card.test` |
| Перегляд цін | E2E «житло: … порівняння цін продавців»; API `test_stay_rates`; WEB `stay-rates.test` |
| Додавання до поїздки | E2E «житло: … додати до поїздки»; API `test_trip_planner::test_pinned_stay_is_used_where_available`; WEB `stay-rates.test` (tripFromStay) |

## 21.3 Планувальник

| Сценарій | Тести |
|---|---|
| Підбір комбінацій | E2E «поїздка: загальна сума, три варіанти…», «поїздка 8a…»; API `test_trip_planner::test_combos_totals_and_picks` |
| Зміна рейсу | E2E «поїздка 8b…»; API `test_pinned_flight_becomes_your_trip_with_options` |
| Зміна житла | E2E «поїздка 8b…», «поїздка 8c» (редагування); API `test_stay_is_kept_when_compatible…` |
| Зміна дат | E2E «поїздка 8a» (період, тривалість); API `test_flexible_period_and_duration`, `test_flexible_trip_respects_nights_from_arrival`; ШІ `test_assistant_refine` (change_trip) |
| Перерахунок бюджету | E2E «поїздка 8a: … бюджет за статусами»; API `test_budget_filters_picks_or_reports_shortfall`, `test_costs_split_confirmed_approximate_unknown`, `test_currency` |
| Оптимізація вартості | E2E «поїздка 8b: … знайти дешевше»; API `test_cheaper_*` |
| Збереження | E2E «поїздка 8c…», «модуль 20.2…»; INT `test_accounts::test_saved_trips_*` |
| Інші дати й пояснення згорнуті | E2E «матриця туди-назад…» (рядок «від …» → розгорнути), «пошук: підказки міст…» (календар у згорнутому блоці); WEB `ai-explanation.test` |
| Форма над результатами згорнута | E2E «3–5 ночей у грудні…» («Змінити» розгортає форму), `a11y.spec`, `mobile.spec` |
| Вибір не губиться між розділами | E2E «модуль 23b: обрана поїздка не губиться…» (якір «Ваша поїздка», повернення з вибором, помічник згорнутий); WEB `search-modes.test` (returnHref), `trip-builder.test` (заміни з якорем), `trip-card.test` (окремі блоки рейсу й житла) |
| Повторне відкриття | E2E «поїздка 8c» (редагувати → `saved=`), «модуль 20.2» (публічне посилання); WEB `trip-builder.test` |
| Оновлення цін | E2E «поїздка 8c» (оновити ціни); API `test_refresh_reports_current_total_and_availability` |

## 21.4 ШІ

| Сценарій | Тести |
|---|---|
| Розуміння запитів | API `test_query_parser` (30 записаних кейсів, `scripts/eval_parser.py`) |
| Уточнення параметрів | API `test_query_parser` (питання замість вигадки), `test_assistant` |
| Помічник не заважає результатам | WEB `search-tabs.test` (згорнутий за замовчуванням, кнопка, Escape, телефон — згортається на нових результатах); E2E «розмова з ШІ…», «помічник «уся поїздка»…» (після переходу — кнопка повертає розмову) |
| Відповідь ШІ — картками | WEB `ai-chat.test` (модуль 23d: окремі ціни перельоту й житла, головна дія, довгий текст згорнутий) |
| Збереження контексту | E2E «розмова з ШІ-помічником… контекст не губиться»; API `test_ai_api::test_chat_remembers_the_conversation` |
| Зміна фільтрів через чат | API `test_assistant_refine` (refine_flights / refine_stays) |
| Реальні результати пошуку | API `test_assistant` (інструменти шукають через сервіс, числа звіряються) |
| Перенесення до планувальника | E2E «ШІ 9b: картки поїздок у чаті → планувальник» |
| Робота з готовою поїздкою | E2E «ШІ 9a: команди готової поїздки…»; API `test_assistant_refine` (change_trip, undo_trip, compare_trips, save_trip) |
| Мова й дані для моделі | API `test_i18n` (дані ШІ мовою відповіді), `test_assistant::test_preferences_are_not_sent_to_the_model` |

## 21.5 Акаунт

| Сценарій | Тести |
|---|---|
| Авторизація | E2E «кабінет: реєстрація → … вихід і вхід»; INT `test_accounts` (пароль, Google, скидання, сесії); API `test_google_oauth` |
| Збереження профілю | E2E «кабінет…»; INT `test_accounts` (preferences, avatar) |
| Персональні налаштування | INT `test_accounts` (search_prefs, notify_prefs); WEB `search-prefs.test` |
| Обране | E2E «житло: … обране»; INT `test_accounts::test_favorites_*`; WEB `favorites.test` |
| Історія | E2E «кабінет: … історія й збережене»; INT `test_accounts::test_history_*` |
| Поїздки | E2E «поїздка 8c», «модуль 20.2»; INT `test_accounts::test_saved_trips_*`, `test_public_trip_link_*` |
| Сповіщення | E2E «підписка на ціну…», «сповіщення 11a…»; INT `test_alerts`; API `test_alert_rules` |
| Ізоляція даних | INT `test_isolation` (B не бачить і не змінює даних A, без сесії — 401), `test_db_integrity`, `test_row_level_security` |

## 21.6 Крайні випадки

| Сценарій | Тести |
|---|---|
| Відсутність результатів | E2E «модуль 20.5: порожні результати…»; WEB `empty-suggestions.test` |
| Недоступність провайдера | API `test_flight_search_service` (помилка / тайм-аут / ліміт одного джерела), `test_provider_resilience` (повтори, 429 без повтору); WEB `result-filters.test` (ProviderAlerts) |
| Неактуальна ціна | API `test_provider_resilience::test_price_freshness`, `…marks_each_offer_freshness`; WEB `price-freshness.test` |
| Зміна валюти | E2E «модуль 18.2…»; API `test_currency`, `test_fx`; WEB `money.test` |
| Часові пояси | API `test_trip_planner::test_stay_window_is_from_arrival…`, `test_timing_penalties_are_facts_from_local_times`; WEB `format.test` (час — у поясі аеропорту) |
| Нічні рейси | API `test_overnight_flight_books_stay_from_arrival_date…`, `test_flight_ranking::test_night_arrival_is_penalised` |
| Self-transfer | API `test_scoring_engine` (штраф), `test_offer_filters` (min_self_transfer); WEB `risks.test`, `offer-card.test` |
| Немає даних про багаж | API `test_baggage` (unknown ≠ безкоштовно), `test_flight_ranking` (невідоме не відсікає); WEB `offer-card.test` |
| Дублікат рейсу в різних джерелах | API `test_flight_search_service` (offer_groups), `test_sellers`, `test_multi_source` (номери рейсів, пересадки — усі рейси, стара ціна не очолює картку) |
| Одночасні пошуки | API `test_provider_resilience` (однакові запити — один виклик, замок Redis між процесами) |
| Повільне з'єднання | E2E «модуль 21.6: обрив мережі — помилка з повтором»; WEB `client-fetch.test` (тайм-аут) |
| Повторне відкриття збережених результатів | E2E «поїздка 8c», «модуль 20.1/20.3» (останні пошуки), «модуль 20.4» (чернетка після оновлення) |

## Доступність і мобільна версія

`e2e/a11y.spec.ts` (axe, WCAG 2.1 AA, світла й темна теми, телефон, клавіатура), `e2e/mobile.spec.ts` (немає горизонтального прокручування на 390 px).
