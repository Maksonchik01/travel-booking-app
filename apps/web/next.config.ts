import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * Заголовки безпеки для всіх сторінок (V3, етап 4). CSP — лише директиви, що не ламають
 * статичний рендер: `script-src` з nonce вимкнув би пререндер (cacheComponents), тож від XSS
 * захищає React (без `dangerouslySetInnerHTML`) і санітизація даних джерел. `form-action` не
 * ставимо: форма без JS після server action перенаправляє на t.me (прив'язка Telegram).
 */
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  cacheComponents: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  partialPrefetching: true,
  // Standalone-бандл потрібен лише для Docker-образу; `next start` з ним не працює.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  transpilePackages: ["@tickets/shared"],
  // Логотипи авіакомпаній з відповідей SerpApi. Вантажимо через оптимізатор Next:
  // браузер користувача не звертається до Google (GDPR), картинки кешуються в нас.
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "www.gstatic.com",
        port: "",
        pathname: "/flights/airline_logos/**",
        search: "",
      },
      // Фото профілю Google (модуль 10b): теж через оптимізатор — браузер не ходить до Google.
      { protocol: "https", hostname: "*.googleusercontent.com", port: "", pathname: "/**" },
    ],
    qualities: [75],
    minimumCacheTTL: 7 * 24 * 60 * 60,
    maximumRedirects: 0,
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

// Sentry: лише перехоплення помилок. Source maps вантажимо, тільки якщо задано SENTRY_AUTH_TOKEN
// (тоді й SENTRY_ORG / SENTRY_PROJECT); без нього збірка не звертається до Sentry.
export default withSentryConfig(withNextIntl(nextConfig), {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
  telemetry: false,
  silent: !process.env.CI,
});
