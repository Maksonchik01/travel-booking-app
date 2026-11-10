# ADR 0043 — scrape.do: другий шлях до Google Flights

Статус: прийнято.

## Контекст

SerpApi дає 250 запитів на місяць. Власник підключив scrape.do: у нього є готовий Google Flights API
(`GET https://api.scrape.do/plugin/google/flights`, [документація](https://scrape.do/documentation/google-scraper-api/flights/)).
Це та сама видача Google Flights, що й у SerpApi, тож нових продавців він не додає, лише ще одну квоту й незалежність від одного постачальника.

Перевірено реальними запитами (листопад 2026, `apps/api/tests/fixtures/scrapedo/`):

| Що | Як у scrape.do |
|---|---|
| Формат ітинераріїв | як у SerpApi: `best_flights` / `other_flights`, сегменти з місцевим часом без поясу, `layovers`, `total_duration`, `price` за весь склад |
| Ціна | 10 кредитів за запит, безкоштовно 1000 на місяць (≈ 100 запитів); залишок — заголовок `scrape.do-remaining-credits` |
| Туди-назад | лише вильоти з ціною всієї поїздки; `departure_token` ігнорується (та сама відповідь), тож зворотних рейсів немає |
| Продавці | `booking_options` немає |
| Посилання на видачу | немає (`search_metadata` відсутній) |

## Рішення

- **Адаптер** `providers/scrapedo.py`, `ScrapeDoFlightProvider`:
  - розбір ітинераріїв — спільний із `SerpApiFlightProvider` (підклас);
  - власні адреса, параметр `token` і помилки (402/429 — квота, 401/403 — ключ; текст помилки джерела в повідомлення не потрапляє).
- **Запит іде лише з бекенду.** Токен — `SCRAPEDO_TOKEN` у середовищі API, у query string. Логи httpx приглушено, а `redact_secrets` маскує `token=`. Веб і браузер scrape.do не знають.
- **В один бік** — 1 запит.
- **Туди-назад** — 2 запити в один бік (туди й назад), 5 найдешевших × 5 → комбінації «два окремі квитки»:
  - `Offer.separate_tickets = True`;
  - ціна — сума двох квитків;
  - на картці — позначка «Два окремі квитки» з підказкою, що кожен міняється й скасовується окремо.
  
  Ціну туди-назад без деталей повернення не показуємо: це не пропозиція.
- **Бюджет:** `SCRAPEDO_MAX_REQUESTS_PER_SEARCH` (2 — одна пара дат туди-назад). Пара, на яку бюджету не вистачає повністю, не запитується.
- **Кеш:** як в інших джерелах — `CachedFlightProvider` (Redis, `PROVIDER_CACHE_TTL_S`).
- **Продавців** не перевіряємо (`booking_ref=None`, `sellers` → `unsupported`): UI пише, що ціну підтверджує продавець.
- **Посилання** «Google Flights» — пошук `https://www.google.com/travel/flights?q=Flights to … from … on …` (префікс уже дозволений у `outbound.ts`).
- **Алерти** scrape.do не використовують (як і SerpApi — квота).

## Наслідки

- `FLIGHT_PROVIDERS=serpapi,scrapedo,travelpayouts`: пошук туди-назад витрачає до 4 запитів SerpApi і 2 запити scrape.do (20 кредитів).
  - Однаковий рейс з обох — одна картка (`flight_key`). Тариф туди-назад SerpApi і два квитки scrape.do — різні продукти; картку очолює дешевший за `comparable_order`.
  - Без SerpApi (`FLIGHT_PROVIDERS=scrapedo,travelpayouts`) живі ціни лишаються, але без перевірки продавців.
- Історія цін пише суму двох квитків як ціну маршруту туди-назад (джерело `scrapedo`).
