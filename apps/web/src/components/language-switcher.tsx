"use client";

import { Languages } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { saveLocale } from "@/app/actions/profile";
import { LOCALE_COOKIE, LOCALE_NAMES, type Locale, locales } from "@/i18n/config";

/** Коротка назва мови в перемикачі — її власною мовою, не перекладається. */
const LABELS: Record<Locale, string> = { en: "EN", uk: "UK", ru: "RU" };

/** Зберегти вибір мови: cookie на рік (його читає `proxy.ts`). */
export function rememberLocale(locale: Locale): void {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
}

/**
 * Перемикач мови в шапці (модуль 10b). З акаунтом вибір запам'ятовує й профіль (server action;
 * без мережі — лише cookie). Повне перезавантаження, а не router.refresh(): у кеші
 * клієнтського роутера лишились би сторінки попередньою мовою.
 */
export function LanguageSwitcher({
  onChange = saveLocale,
}: {
  onChange?: (locale: Locale) => Promise<void>;
}) {
  const t = useTranslations("nav");
  const current = useLocale() as Locale;
  return (
    <label className="text-muted-foreground hover:text-foreground relative flex h-9 items-center rounded-lg">
      <span className="sr-only">{t("language")}</span>
      <Languages className="pointer-events-none absolute left-2 size-4" aria-hidden />
      <select
        value={current}
        onChange={async (e) => {
          const locale = e.target.value as Locale;
          rememberLocale(locale);
          await onChange?.(locale).catch(() => undefined);
          window.location.reload();
        }}
        className="hover:bg-muted h-9 cursor-pointer appearance-none rounded-lg bg-transparent pr-2 pl-7 text-xs font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
        data-testid="language-switcher"
      >
        {locales.map((locale) => (
          <option key={locale} value={locale} title={LOCALE_NAMES[locale]}>
            {LABELS[locale]}
          </option>
        ))}
      </select>
    </label>
  );
}
