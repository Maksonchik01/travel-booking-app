import { locale as rootLocale } from "next/root-params";
import { getRequestConfig } from "next-intl/server";

import { defaultLocale, isLocale } from "./config";

// Мова — з кореневого параметра `[locale]` (next/root-params): кеш сторінок ділиться за мовою,
// а не стає динамічним через cookie. Невідоме значення — мова за замовчуванням.
export default getRequestConfig(async ({ locale: explicit }) => {
  const value = explicit ?? (await rootLocale());
  const locale = isLocale(value) ? value : defaultLocale;
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
