import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import Script from "next/script";

import { locales } from "@/i18n/config";
import { clientMessages } from "@/lib/client-messages";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import "../globals.css";

import { SkipLink } from "@/components/skip-link";

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
      <body className="flex min-h-full flex-col">
        <Script id="theme-init" strategy="beforeInteractive">
          {THEME_INIT_SCRIPT}
        </Script>
        <NextIntlClientProvider messages={messages}>
          {/* Перший Tab — одразу до вмісту, повз шапку (WCAG 2.4.1). */}
          <SkipLink />
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
