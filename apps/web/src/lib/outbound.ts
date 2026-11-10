import type { ClickIn } from "@tickets/shared";

/**
 * Куди можна перейти з «Забронювати». Посилання приходять від провайдерів (недовірені),
 * тож `/out` редиректить лише на ці префікси — інакше це був би відкритий редирект.
 * Новий провайдер з посиланнями — новий префікс тут.
 */
export const ALLOWED_PREFIXES = [
  "https://www.aviasales.com/", // Travelpayouts (з партнерським marker)
  "https://www.google.com/travel/flights", // SerpApi: та сама видача в Google Flights
  "https://www.google.com/travel/search?", // scrape.do: готель у Google Hotels (ADR 0044)
  "https://www.google.com/travel/lodging/clk?", // scrape.do: продавець готелю з Google Hotels
  "https://www.google.com/aclk?", // scrape.do: рекламне розміщення продавця (позначене)
] as const;

export type ClickKind = ClickIn["kind"];

export function isAllowedOutbound(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // Порівнюємо нормалізований рядок: "https://www.aviasales.com@evil" чи "\\" сюди не пройдуть.
  return (
    parsed.username === "" &&
    parsed.password === "" &&
    ALLOWED_PREFIXES.some((prefix) => parsed.href.startsWith(prefix))
  );
}

/** Посилання кнопки «Забронювати»: через наш `/out`, щоб перевірити адресу й порахувати клік. */
export function outboundHref(url: string, kind: ClickKind, source: string): string {
  return `/out?${new URLSearchParams({ url, kind, source })}`;
}
