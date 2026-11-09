/**
 * Мови інтерфейсу (модуль 10b): англійська за замовчуванням, українська, російська.
 * Мова — кореневий параметр маршруту `app/[locale]` (Next 16 + cacheComponents: сторінки
 * кешуються окремо для кожної мови), а в адресі її немає: `proxy.ts` бере мову з cookie
 * `NEXT_LOCALE` і робить внутрішній rewrite `/trip` → `/en/trip`.
 */
export const locales = ["en", "uk", "ru"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";
export const LOCALE_COOKIE = "NEXT_LOCALE";

/**
 * Назва мови її ж мовою — так її впізнає той, хто цієї мови не читає. Не перекладається,
 * тож живе тут, а не в messages (і це єдині не-англійські рядки в коді — дозволяє тест).
 */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  uk: "Українська",
  ru: "Русский",
};

export function isLocale(value: string | null | undefined): value is Locale {
  return !!value && (locales as readonly string[]).includes(value);
}
