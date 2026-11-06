import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  cacheComponents: true,
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

export default withNextIntl(nextConfig);
