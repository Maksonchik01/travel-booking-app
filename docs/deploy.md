# Деплой: фронтенд на Vercel, бекенд на Render

```
браузер → Vercel (Next.js, apps/web) → Render: tickets-api (FastAPI) → Postgres, Key Value (Redis)
                                        Render: tickets-worker (ARQ: алерти, Telegram-бот)
```

Next звертається до API лише із сервера (`API_URL`), тож CORS для браузера не потрібен.

## 1. Бекенд — Render (Blueprint)

1. Dashboard → **New → Blueprint** → репозиторій → гілка `main`. Render прочитає
   [`render.yaml`](../render.yaml): API (free), воркер (платний, ~0.5 CPU), Key Value (free),
   Postgres 16 (free, видаляється через 30 днів).
2. Введіть секрети, які попросить Render (`sync: false`): значення — з вашого `.env`.
   `PUBLIC_WEB_URL` і `CORS_ORIGINS` — адреса Vercel з кроку 2 (можна спершу
   `https://example.com` і змінити пізніше: Environment → Save → redeploy).
3. Після деплою адреса API — `https://tickets-api.onrender.com` (або з суфіксом, якщо назва
   зайнята; див. сторінку сервісу). Перевірка: `curl https://…/health/ready`.

Міграції запускаються на старті API (`dockerCommand`): `preDeployCommand` на free-плані недоступний.

## 2. Фронтенд — Vercel

1. **Add New → Project** → той самий репозиторій → **Root Directory: `apps/web`**.
   Install Command і регіон — з [`apps/web/vercel.json`](../apps/web/vercel.json)
   (npm 11: npm 10 падає на peer-залежностях workspaces).
2. Environment Variables: `API_URL` = адреса API з кроку 1.3.
3. Deploy. Адресу `https://<проєкт>.vercel.app` впишіть у Render як `PUBLIC_WEB_URL`
   (API і воркер) і `CORS_ORIGINS` (API).

## 3. Після деплою

- **Google OAuth** (Google Cloud Console → Credentials → ваш OAuth client):
  Authorized redirect URIs — додати `https://<проєкт>.vercel.app/api/auth/google/callback`;
  Authorized JavaScript origins — `https://<проєкт>.vercel.app`.
- **Telegram:** одночасно `getUpdates` може читати лише один процес. Зупиніть локальний
  воркер (`docker compose stop worker`) або дайте локальній розробці окремого бота.
- Free-сервіс API засинає без запитів: перший запит після паузи — до хвилини.

## Обмеження

- Без SMTP листи (підтвердження пошти, скидання пароля) лише в лог воркера/API.
- SerpApi-квота (250/міс) спільна для локальної розробки й продакшену.
