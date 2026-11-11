# Деплой: фронтенд на Vercel, бекенд на Render

```
браузер → Vercel (Next.js, apps/web) → Render: tickets-api (FastAPI) → Supabase Postgres, Render Key Value (Redis)
                                        Render: tickets-worker (ARQ: алерти, Telegram-бот)
```

Next звертається до API лише із сервера (`API_URL`), тож CORS для браузера не потрібен.

## 0. База — Supabase ([ADR 0012](adr/0012-supabase-postgres.md))

1. supabase.com → New project, регіон **Central EU (Frankfurt)**, згенерований пароль бази
   збережіть.
2. Project Settings → Data API → вимкніть Data API (таблиці й так закриті RLS, міграція 0009, а з 0020 ролі `anon`/`authenticated` не мають на них прав).
3. **Connect → Connection String → Session pooler** — рядок
   `postgresql://postgres.<ref>:<пароль>@aws-…pooler.supabase.com:5432/postgres`. Це
   `DATABASE_URL` для API й воркера на Render (не Direct — він лише IPv6; не Transaction pooler).

## 1. Бекенд — Render (Blueprint)

1. Dashboard → **New → Blueprint** → репозиторій → гілка `main`. Render прочитає
   [`render.yaml`](../render.yaml): API (free), воркер (платний, ~0.5 CPU), Key Value (free).
2. Введіть секрети, які попросить Render (`sync: false`): значення — з вашого `.env`.
   `PUBLIC_WEB_URL` і `CORS_ORIGINS` — адреса Vercel з кроку 2 (можна спершу
   `https://example.com` і змінити пізніше: Environment → Save → redeploy).
3. Після деплою адреса API — `https://tickets-api.onrender.com` (або з суфіксом, якщо назва
   зайнята; див. сторінку сервісу). Перевірка: `curl https://…/health/ready`.

Міграції запускаються на старті API (CMD у `apps/api/Dockerfile`): `preDeployCommand` на free-плані недоступний.

## 2. Фронтенд — Vercel

1. **Add New → Project** → той самий репозиторій → **Root Directory: `apps/web`**.
   Install Command і регіон — з [`apps/web/vercel.json`](../apps/web/vercel.json)
   (npm 11: npm 10 падає на peer-залежностях workspaces).
2. Environment Variables: `API_URL` = адреса API з кроку 1.3; `INTERNAL_API_KEY` — той самий
   секрет, що в Render (без нього ліміти запитів рахуються на весь Vercel, а не на відвідувача).
3. Deploy. Адресу `https://<проєкт>.vercel.app` впишіть у Render як `PUBLIC_WEB_URL`
   (API і воркер) і `CORS_ORIGINS` (API).

## 3. Після деплою

- **Google OAuth** (Google Cloud Console → Credentials → ваш OAuth client):
  Authorized redirect URIs — додати `https://<проєкт>.vercel.app/api/auth/google/callback`;
  Authorized JavaScript origins — `https://<проєкт>.vercel.app`.
- **Telegram:** одночасно `getUpdates` може читати лише один процес. Зупиніть локальний
  воркер (`docker compose stop worker`) або дайте локальній розробці окремого бота.
- Free-сервіс API засинає без запитів: перший запит після паузи — до хвилини.

## 4. Моніторинг

- **Sentry** (sentry.io, регіон EU; проєкти `tickets-api` — FastAPI, `tickets-web` — Next.js, лише
  Error Monitoring): `SENTRY_DSN` у Render (API і воркер), `NEXT_PUBLIC_SENTRY_DSN` у Vercel.
  Персональних даних не шлемо: в API `send_default_pii=False`, у вебі `dataCollection` вимикає
  cookies, заголовки, тіла й query-параметри (`apps/web/src/lib/sentry-options.ts`).
- **Зведення:** `curl -H "X-Internal-Key: <INTERNAL_API_KEY>" https://<api>/ops/summary` —
  квота SerpApi (Account API, квоту не витрачає), бюджети й витрати API (`api_spend`), виклики й вартість LLM,
  кліки на партнерів, записані ціни за добу, користувачі, активні підписки.
- **Розділ власника `/ops`** ([ADR 0062](adr/0062-monitoring-and-owner-alerts.md)): бюджети й витрати платних API,
  собівартість пошуку, кеш, джерела, ліміти запитів, ШІ — і зміна лімітів без редеплою. У Vercel: `OPS_ADMINS`
  (ваш логін SkyPack) і той самий `INTERNAL_API_KEY`, що в Render.
- **Технічні сповіщення** (воркер, раз на 15 хв): у Render для воркера — `OPS_API_URL` (адреса API),
  `OPS_TELEGRAM_CHAT_ID` (ваш chat id: напишіть боту `/start`, потім
  `https://api.telegram.org/bot<TOKEN>/getUpdates` → `message.chat.id`) і/або `OPS_ALERT_EMAIL` (потрібен SMTP).
- **Критичні помилки коду** — правило сповіщень у Sentry (Alerts → «A new issue is created» → email).
- **Аптайм:** `GET /health/ready` — для зовнішнього монітора (UptimeRobot, Better Stack тощо): він помітить і
  падіння всього Render, коли воркер сам не зможе сповістити.

## 5. Реліз і відкат (V3, етап 11)

**Перед релізом (автоматично).** Кожен push і PR — GitHub Actions ([ci.yml](../.github/workflows/ci.yml)): ruff, mypy
strict, pytest разом з інтеграційними (Postgres, Redis), міграції upgrade → downgrade → upgrade, eslint, tsc, vitest,
збірка вебу, Playwright e2e. У `main` — лише зелене. Тест `test_env_example` не дає додати змінну `Settings` без рядка
в `.env.example` (а отже — без нагадування налаштувати її в Render/Vercel).

**Preview.** Vercel сам створює preview-деплой для кожної гілки й PR — перевірте його перед злиттям. Preview ходить у
той самий API (його квоти й бюджети), тож навантажувати його не варто; `INTERNAL_API_KEY` для Preview можна не
задавати.

**Змінні оточення.** Секрети — лише в Render і Vercel (Environment), у репозиторії — тільки `.env.example`. Змінили
змінну в Render — потрібен redeploy (Save → Deploy).

**Міграції.** API застосовує їх сам при старті (`alembic upgrade head` у CMD образу). Правила:
- лише сумісні з попереднім кодом (додати колонку / таблицю → реліз → прибрати старе в наступному релізі): під час
  деплою старий екземпляр ще працює з новою схемою;
- міграція впала — новий екземпляр не стартує, Render лишає попередній деплой (health check), сайт працює;
- перед ризиковою міграцією — резервна копія (`scripts/backup_db.sh`, розділ 6);
- `make migrate` ніколи не запускаємо з продакшн-`.env`.

**Відкат.**
- Веб: Vercel → Deployments → попередній → **Instant Rollback** (секунди).
- API й воркер: Render → сервіс → Events → попередній деплой → **Rollback**.
- Схема бази сама не відкочується. Сумісні міграції цього й не потребують (старий код працює з розширеною схемою);
  руйнівну — лише свідомо: резервна копія → `alembic downgrade <ревізія>` з явним `DATABASE_URL` → перевірка `/health/ready`.

## 6. Резервні копії й відновлення

**Supabase Free автоматичних копій не робить** (документація Supabase радить власні дампи; щоденні копії з відновленням
у дашборді — лише з Pro, 7 днів). Тому:
- `scripts/backup_db.sh` — логічна копія (`pg_dump` 17 у Docker, адреса — `SUPABASE_DATABASE_URL` з `.env`, лише
  читання) у `backups/` (у `.gitignore`). Щотижня й перед ризиковою міграцією.
- Копія містить персональні дані — зберігайте зашифровано (напр. зашифрований диск чи архів), старі видаляйте.

**Відновлення.**
1. Новий проєкт Supabase (Frankfurt) або той самий; Session pooler — нова адреса.
2. `docker run --rm -i -e URL='<адреса>' postgres:17-alpine sh -c 'pg_restore --no-owner --no-privileges --clean
   --if-exists -d "$URL"' < backups/skypack-<дата>.dump`
3. Render → API і воркер → `DATABASE_URL` = нова адреса → redeploy (міграції дотягнуть схему до поточної).
4. Перевірка: `/health/ready` — `ok`; `/ops` — зведення; вхід у свій акаунт.

**Втрата Redis** (Render Key Value): даних користувачів там немає — кеш, ліміти, лічильники бюджетів, діалоги бота.
Лічильник місячного бюджету обнулиться: тимчасово зменште ліміти в `/ops`, доки не звіритесь із кабінетами SerpApi і
scrape.do.

## Обмеження

- Без SMTP листи (підтвердження пошти, скидання пароля) лише в лог воркера/API.
- SerpApi-квота (250/міс) спільна для локальної розробки й продакшену.
