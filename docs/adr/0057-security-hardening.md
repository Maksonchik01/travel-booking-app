# ADR 0057 — Посилення безпеки (V3, етап 4)

Статус: прийнято. Знахідки M1–M3 аудиту ([v3-audit.md](../v3-audit.md)) і повторна перевірка безпеки.

## Знайдено й виправлено

- **Відкрите перенаправлення після входу.** `next=/\evil.example` проходив перевірку (`/` на початку, не `//`),
  а браузер читає `\` як `/` → `//evil.example`. Тепер — `safeLocalPath` (`lib/safe-path.ts`): без `\` і керівних
  символів, після розбору URL origin має лишатися нашим. Застосовано і в server action входу, і на сторінці входу.
- **Заголовки безпеки вебу** (`next.config.ts`): `X-Frame-Options: DENY` і CSP `frame-ancestors 'none'; base-uri
  'self'; object-src 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy` (камера, мікрофон, геолокація, платежі, USB — вимкнено), HSTS, без `X-Powered-By`.
  `script-src` з nonce не ставимо: він вимикає пререндер (cacheComponents). Від XSS захищає React (жодного
  `dangerouslySetInnerHTML` у коді) і те, що дані джерел лише показуються як текст. `form-action` не ставимо: без JS
  форма прив'язки Telegram після server action перенаправляє на t.me.
- **Документація API** (`/docs`, `/redoc`, `/openapi.json`) — лише поза продакшном. Типи для вебу —
  `make gen-types` (будує схему напряму, без HTTP).
- **Ідентифікатор запиту** (`core/request_context.py`): `X-Request-ID` від вебу (той передає `x-vercel-id`) або
  згенерований — у кожному рядку логу запиту (structlog contextvars), тег Sentry і заголовок відповіді. Відповіді API —
  `nosniff` і `Cache-Control: no-store` за замовчуванням.

## Перевірено без змін

- **Supabase (продакшн, лише читання каталогу, 2026-11-11):** 16 таблиць — усі з RLS, політик немає, ролі `anon` і
  `authenticated` не мають прав на таблиці, послідовності й функції `public` → Data API нічого не віддає; бекенд
  працює своєю роллю. Міграції — `0025`.
- **Секрети:** у git — лише `.env.example`, `.env` ніколи не комітився; у браузерних бандлах `.next/static` немає
  значень жодної секретної змінної (перевірено 9); у вебі з `NEXT_PUBLIC_*` — лише адреса API і DSN Sentry.
- **Доступ до даних:** усі операції з обраним, поїздками, чатами, історією, алертами акаунта фільтруються за
  `user_id` власника; публічна поїздка — `share_token` 144 біти, лише `SharedTrip` без особистого; вихід видаляє
  сесію, видалення акаунта — каскадом від `users`.
- **Ін'єкції:** SQL — лише через SQLAlchemy з параметрами (сирий `text()` — тільки `select 1` у health).
- **SSRF:** сервер ходить лише на хости з конфігурації (джерела, ECB, Nominatim, Google OAuth); `next/image` —
  лише `www.gstatic.com/flights/airline_logos` і `*.googleusercontent.com`, без перенаправлень.
- **Перенаправлення назовні** — лише `/out` з дозволеними префіксами; OAuth Google — з `state` і PKCE.
- **Адмін-доступ:** ролі адміністратора немає; зведення для власника — `X-Internal-Key` (порівняння за сталий час).
