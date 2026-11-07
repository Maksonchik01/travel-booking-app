import * as Sentry from "@sentry/nextjs";

import { sentryOptions } from "@/lib/sentry-options";

export function register() {
  // Сервер і edge: ті самі налаштування, що й у браузері (src/lib/sentry-options.ts).
  Sentry.init(sentryOptions);
}

/** Помилки серверних компонентів, route handlers і server actions. */
export const onRequestError = Sentry.captureRequestError;
