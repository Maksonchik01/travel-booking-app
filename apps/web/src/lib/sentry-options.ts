import type { BrowserOptions } from "@sentry/nextjs";

/**
 * Спільні налаштування Sentry для браузера, сервера й edge. Лише помилки: без трасування,
 * Session Replay і зворотного зв'язку. Без NEXT_PUBLIC_SENTRY_DSN SDK вимкнений.
 *
 * GDPR (як `send_default_pii=False` в API): жодних cookies, заголовків, тіл запитів і
 * query-параметрів — у них сесія, токени підписок (/alerts?token=) і параметри пошуку.
 */
export const sentryOptions = {
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN || undefined,
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
  },
} satisfies BrowserOptions;
