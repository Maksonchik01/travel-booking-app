import { loadSentry, reportError } from "@/lib/sentry-client";
import { sentryOptions } from "@/lib/sentry-options";

/**
 * Sentry вантажимо, коли браузер вільний (після першого рендеру), а не з основним бандлом.
 * Помилки до того не губимо: ранні обробники передають їх у SDK і знімаються, щойно він
 * завантажився (далі ловить сам Sentry).
 */
if (typeof window !== "undefined" && sentryOptions.dsn) {
  const onError = (event: ErrorEvent) => reportError(event.error ?? event.message);
  const onRejection = (event: PromiseRejectionEvent) => reportError(event.reason);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  const start = () =>
    void loadSentry().then(() => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    });
  if ("requestIdleCallback" in window) window.requestIdleCallback(start, { timeout: 5000 });
  else setTimeout(start, 2000);
}
