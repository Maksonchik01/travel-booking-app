export const locales = ["uk"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "uk";
