import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";

import { locales } from "@/i18n/config";
import { clientMessages } from "@/lib/client-messages";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import "../globals.css";

import { AnalyticsListener } from "@/components/analytics-listener";
import { SkipLink } from "@/components/skip-link";
import { HINTS_INIT_SCRIPT } from "@/lib/hints";
import { SEARCH_SHELL_SCRIPT } from "@/lib/search-shell";
import { SearchShellSync } from "@/components/search-shell";
import { Suspense } from "react";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin", "cyrillic"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin", "cyrillic"],
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta");
  return { title: t("title"), description: t("description") };
}

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export default async function RootLayout({ children }: LayoutProps<"/[locale]">) {
  const locale = await getLocale();
  // У браузер — лише переклади клієнтського коду, а не весь словник (модуль 17.5).
  const messages = clientMessages(await getMessages());
  return (
    // suppressHydrationWarning: клас `dark` ставить скрипт теми до гідратації.
    <html
      lang={locale}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/*
          Синхронно, до першого відмальовування: тема (без спалаху світлої) і стан сторінки
          пошуку (заглушка потрібного розміру, етап 9 V3). `next/script` beforeInteractive тут не
          годиться — його виконує рантайм Next уже після першого кадру. Текст — сталий, без даних
          користувача (ADR 0057).
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `${THEME_INIT_SCRIPT}${SEARCH_SHELL_SCRIPT}${HINTS_INIT_SCRIPT}`,
          }}
        />
      </head>
      <body className="flex min-h-full flex-col">
        <NextIntlClientProvider messages={messages}>
          {/* Перший Tab — одразу до вмісту, повз шапку (WCAG 2.4.1). */}
          <SkipLink />
          <AnalyticsListener />
          <Suspense fallback={null}>
            <SearchShellSync />
          </Suspense>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
