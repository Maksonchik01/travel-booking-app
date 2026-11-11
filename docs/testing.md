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

Живі джерела (SerpApi — квота 250 на місяць, scrape.do — 1000 кредитів) у тестах не використовуються: лише записані фікстури (`tests/fixtures/serpapi`, `scrapedo`, `travelpayouts`, `ecb`).

## 21.1 Авіаквитки

| Сценарій | Тести |
|---|---|
| One-way | E2E «пошук: підказки міст → результати…» (в один бік); API `test_serpapi_provider` (type=2), `test_scrapedo_provider`, `test_mock_provider` |
| Round-trip | E2E «картка…», «гнучкі дати…», «матриця…»; API `test_serpapi_provider` (повернення через departure_token), `test_scrapedo_provider` (два квитки в один бік) |
| Два окремі квитки | API `test_scrapedo_provider`; web `offer-card.test` (позначка «Два окремі квитки») |
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

## Головна, підказки, позиція списку (ADR 0053)

| Сценарій | Тест |
|---|---|
| Обкладинки категорій з довідника | API `test_explore::test_category_covers_for_home` |
| Повторний пошук напрямків — з кешу, без звернень до джерела | API `test_explore::test_repeated_explore_is_served_from_cache` |
| Підказка один раз; позиція списку лише після «Назад» | WEB `feature-hint.test` |
| Головна → категорія → Explore; підказка після перезавантаження; «Показати ще» → деталі → «Назад» | E2E «етап 9: головна з ідеями…» |

## ШІ-помічник і Explore (ADR 0052)

| Сценарій | Тест |
|---|---|
| «Куди з Амстердама за 400 €» — напрямки, картки, Explore з тими самими умовами | API `test_assistant_explore::test_where_to_fly_on_budget_gives_destinations_cards_and_explore_link` |
| «В Європу на вихідні, удвох, до 900 € з житлом» — сума від коду | API `test_assistant_explore::test_europe_weekends_and_trip_for_two_with_budget` |
| «Порівняй Рим і Барселону» — лише ці міста, `not_found` | API `test_assistant_explore::test_compare_two_named_cities` |
| Минула дата — назад моделі; вигадана сума — відхилено | API `test_assistant_explore::test_invented_total_is_rejected_and_past_date_goes_back` |
| Помічник на Explore: картки напрямків і перехід | E2E «етап 8: помічник шукає напрямки…» |

## Збереження гостя й чекліст (ADR 0051)

| Сценарій | Тест |
|---|---|
| Перенесення поїздок, пошуків, обраного-напрямку двічі — без дублікатів, з чеклістом | INT `test_guest_import::test_guest_saves_move_once_without_duplicates` |
| Чекліст: додати, змінити, виконати, видалити; чужий — 404 | INT `test_guest_import::test_trip_checklist_add_edit_toggle_delete` |
| Валідація пункту й напрямку (фото — лише з довідника) | API `test_guest_import::test_checklist_and_destination_validation` |
| Пошук гостя без дублікатів; пропозиція перенесення, збій, «Не зараз»; чекліст гостя | WEB `guest-saves.test` |
| Без згоди провайдер не переносить | WEB `stay-rates.test` (обране з акаунтом) |
| Гість: напрямок і пошук → вхід → «Перенести» → в акаунті | E2E «етап 7: гість зберігає напрямок…» |

## Історія цін і умови сповіщень (ADR 0050)

| Сценарій | Тест |
|---|---|
| Ряд перельоту: мінімум за день, день знаходження, лише той самий склад/тип/валюта, 90 днів | INT `test_price_series::test_flight_series_is_min_per_day_for_same_trip` |
| Ряд житла: ціна видачі без тарифів продавців, «мало даних» | INT `test_price_series::test_stay_series_uses_listing_price_only` |
| Без бази — порожній ряд | API `test_price_series::test_history_endpoints_without_database_are_empty` |
| «Прямий дешевше 100 €», «готель від 8/10», «поїздка до 500 €», валідація, текст маршруту | API `test_alert_rules::test_direct_and_rating_conditions`, `test_stay_source_requires_rating` |
| Графік: діапазон, зміна, підказка, таблиця; «мало даних»; умови з пошуку | WEB `price-history-chart.test` |
| Історія в рейсах і на сторінці готелю; підписка з «лише прямі» | E2E «етап 6: історія цін…» |

## Житло біля місця, «Більше налаштувань» (ADR 0049)

| Сценарій | Тест |
|---|---|
| Nominatim: місто-рамка, User-Agent, кеш (ключ — хеш), биті рядки, помилки | API `test_geocoder` (записана відповідь) |
| `/places/geocode` — збій джерела не ламає | API `test_geocoder::test_geocode_api_is_graceful` |
| Пошук лише кнопкою, вибір → `near`/`nearname`, помилка | WEB `near-place.test` |
| `nearname` лише з `near`, «ближче до місця», відстань по прямій | WEB `near-place.test` |
| «Більше налаштувань»: рейси (пересадки, виліт), житло (рейтинг, тип) | E2E «етап 5: «Більше налаштувань»…» |

## Порівняння варіантів поїздки (ADR 0048)

| Сценарій | Тест |
|---|---|
| Конкретні відмінності з порогами | API `test_trip_insights::test_differences_are_concrete_facts` |
| Краще в межах бюджету / не дорожче за поточний | API `test_trip_insights::test_better_within_budget_or_not_pricier_than_current` |
| До двох підказок з реальних комбінацій, поріг економії | API `test_trip_insights::test_recommendations_up_to_two_from_real_combos` |
| Час у місті, дорога до аеропорту в сумі, підказки в планувальнику | API `test_trip_insights::test_planner_gives_city_time_insights_and_airport_road` |
| «Знайти дешевший» — відмінності | API `test_trip_insights::test_cheaper_reports_differences` |
| Зведення (фото, дні/ночі/години), сторінка готелю, підказка й «краще», `road=` | WEB `trip-builder.test` |
| Підказка дат у рейсах, `road=` в URL | WEB `flight-hints.test` |
| «Ваша поїздка»: час у місті, готель, краще в бюджеті, дорога → нова сума | E2E «етап 4: «Ваша поїздка»…» |

## Швидкі дати (ADR 0047)

| Сценарій | Тест |
|---|---|
| Правило вихідних (чт–сб → сб–пн, ≤ 4 ночей) | API `test_weekend_dates::test_weekend_trip_rule` |
| Пошук лишає лише пари вихідних | API `test_weekend_dates::test_search_keeps_only_weekend_pairs` |
| SerpApi без кандидатів — запити лише на пт/сб | API `test_weekend_dates::test_serpapi_without_candidates_spends_quota_on_weekends_only` |
| Валідація, поїздка передає «вихідні» лише з періодом | API `test_weekend_dates::test_weekends_need_a_round_trip_period` |
| Пресети від «сьогодні» й обраної дати | WEB `date-presets.test` |
| Пресети у формі рейсів (місяць, період, ночі, `wk`) | WEB `search-form.test` |
| Вихідні місяця в рейсах, 5–7 днів у поїздці | E2E «модуль 3: швидкі дати…» |

## Кілька аеропортів (ADR 0046)

| Сценарій | Тест |
|---|---|
| Усі обрані аеропорти — в одному запиті SerpApi; Travelpayouts — кожна пара | API `test_multi_airport::test_serpapi_one_request_for_all_airports`, `test_travelpayouts_asks_each_pair` |
| Перший аеропорт кожного міста гарантовано, сусідні — після обраних | API `test_multi_airport::test_directory_keeps_every_picked_place_first` |
| Фільтр маршруту й історія цін за фактичним обраним аеропортом | API `test_multi_airport::test_route_filter_accepts_any_picked_airport`, `test_history_route_is_the_picked_airport_the_flight_uses` |
| Валідація, ключ кешу, поїздка передає аеропорти перельоту | API `test_multi_airport::test_validation_and_trip_pass_through`, `test_extra_airports_are_part_of_the_cache_key` |
| URL: повторювані й через кому, без повторів, туди й назад | WEB `search-params.test` |
| «Чипи»: назви з кодів, додати за кодом, заборона повторів, до 4, прибрати | WEB `extra-places.test` |
| Рейси з кожного аеропорту, «чип» у формі, поїздка | E2E «модуль 2: кілька аеропортів вильоту…» |

## Explore (ADR 0045)

| Сценарій | Тест |
|---|---|
| «Будь-куди»: запит без `destination`, обидва `unique`, об'єднання без дублів | API `test_explore::test_provider_asks_for_any_destination_both_unique_variants` (записані відповіді AMS) |
| Найдешевший квиток на місто в межах бюджету (× дорослі), без міста вильоту, історія цін | API `test_explore::test_cheapest_fitting_ticket_per_city_within_budget` |
| Країна, регіон, категорія «море» лише в сезон | API `test_explore::test_region_country_and_category_narrow_destinations` |
| Вихідні й точні дати | API `test_explore::test_weekends_and_exact_dates` |
| Авіаквитки + житло: лише 3 найдешевші, сума ≤ бюджету, нагорі | API `test_explore::test_trip_mode_prices_stays_only_for_cheapest_three` |
| Збій джерела — статус, а не помилка | API `test_explore::test_source_failure_is_reported_not_raised` |
| Довідник напрямків (міста, категорії, фото з Вікімедіа, регіони без дублів) | API `test_explore::test_destination_reference_is_consistent` |
| URL ↔ запит, переходи в рейси й поїздку, «Будь-куди» з форми, швидкі дати, послаблення | WEB `explore-params.test` |
| Картка (фото з атрибуцією, сума, житло), порівняння до 3 (таблиця й картки), форма | WEB `explore.test` |
| Рейси → «Будь-куди» → порівняння → + житло → карта → поїздка | E2E «Explore: «Будь-куди» з рейсів…»; доступність і телефон — `a11y.spec`, `mobile.spec` |
| Explore для тих, хто не знає куди: «не знаю» першим, дата ± похибка, пропозиції з фото, попередження про в'їзд (ADR 0054) | `explore-params.test` (`dateWindow`, `windowOf`, `featuredPicks`), `explore.test` (форма); E2E «Explore для тих, хто не знає куди…»; `a11y.spec`/`mobile.spec` — `explore-start` |

## 21.2 Житло

| Сценарій | Тести |
|---|---|
| Пошук за містом | E2E «житло: пошук → наш вибір…»; API `test_stays` |
| Дати | API `test_stays` (ночі, check_out > check_in); WEB `stay-params.test` |
| Кількість гостей | API `test_stays` (Guests, кімнати); WEB `stay-params.test` |
| Фільтри | E2E «житло: … фільтр»; API `test_stay_filters`; WEB `stay-filters.test` |
| Карта | E2E «карта житла…», `mobile.spec` (карта); WEB `stay-map.test` |
| Вибір об'єкта | E2E «житло: детальніше…»; WEB `stay-card.test` |
| Сторінка об'єкта (фото, опис, ціни продавців) | E2E «житло: картка → сторінка об'єкта…», `mobile.spec`, `a11y.spec` (stay-hotel); API `test_scrapedo_stays`, `test_stay_rates::test_stay_detail_api`; WEB `stay-hotel.test` |
| Google Hotels (scrape.do) | API `test_scrapedo_stays` (записані відповіді: фото, опис, продавці, склад гостей); `test_trip_planner::test_stay_with_unknown_taxes_is_approximate` |
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

## Бюджет платних API (ADR 0055)

| Сценарій | Тест |
|---|---|
| Ліміт тримається під одночасними запитами (30 → рівно 10) | API `test_api_budget::test_limits_hold_under_concurrent_requests` (Redis) |
| Неуспішний запит повертає резерв; 5xx не витрачає квоту | `test_failed_request_returns_the_reservation`, `test_budget_blocks_the_provider_without_an_http_call` |
| Необов'язкові операції зупиняються раніше за пошук | `test_optional_operations_stop_before_essential` |
| Вичерпаний бюджет — без HTTP-запиту, джерело `rate_limited`, інші працюють | `test_budget_blocks_the_provider_without_an_http_call`, `test_flight_search_service` (stub `budget`) |
| Звіт: використання, вартість, собівартість успішного пошуку; попередження один раз | `test_spend_summary_and_cost_per_successful_search`, `test_warning_is_logged_once_per_period` |
| Redis недоступний — запит пропускаємо; секція звіту падає окремо | `test_redis_down_lets_requests_through`, `test_ops` |

## Ліміти зловживань і витрати ШІ (ADR 0056)

| Сценарій | Тест |
|---|---|
| Дорогі операції — свій менший кошик; звичайний пошук не зачіпають | API `test_rate_limit::test_expensive_operations_have_their_own_smaller_bucket` |
| Дешеві читання теж обмежені | `test_lookups_are_limited_too` |
| Акаунт — власний кошик × 2, перевірка токена з кешу; підроблений токен — кошик IP | `test_signed_in_user_gets_own_bucket_and_forged_token_does_not` |
| Одночасні пошуки одного клієнта — до ліміту, лічильник повертається | `test_concurrent_searches_per_client_are_capped` |
| Тіло > 1 МБ (і потоком без Content-Length) — 413 | `test_oversized_body_is_rejected` |
| Ліміт витрат ШІ на добу; без Redis ШІ працює | `test_llm_metering::test_spend_guard_stops_ai_at_the_daily_budget` (Redis), `test_spend_guard_lets_ai_work_without_redis` |

