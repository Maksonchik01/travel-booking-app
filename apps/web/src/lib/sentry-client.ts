import { sentryOptions } from "@/lib/sentry-options";

type SentryModule = typeof import("@sentry/nextjs");

let loading: Promise<SentryModule | null> | null = null;

/**
 * Sentry у браузері — ліниво (модуль 17.5): SDK ≈ 120 КБ gzip не вантажиться з кожною сторінкою,
 * а без DSN (локально, прев'ю) — не вантажиться взагалі. Ініціалізація — один раз.
 */
export function loadSentry(): Promise<SentryModule | null> {
  if (!sentryOptions.dsn) return Promise.resolve(null);
  loading ??= import("@sentry/nextjs")
    .then((Sentry) => {
      Sentry.init(sentryOptions);
      return Sentry;
    })
    .catch(() => null); // не завантажився (офлайн, блокувальник) — сайт працює й так
  return loading;
}

/** Повідомити про помилку: завантажує SDK, якщо ще не завантажений. */
export function reportError(error: unknown): void {
  void loadSentry().then((Sentry) => Sentry?.captureException(error));
}
