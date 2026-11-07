/**
 * «Зберегти налаштування» фільтрів перельотів: гість — у цьому браузері (localStorage),
 * з акаунтом — ще й у профілі (PUT /account/flight-filters). Новий пошук з форми додає їх
 * до запиту, поки користувач не зніме позначку. Зберігаємо лише ключі фільтрів видачі.
 */
export const FLIGHT_FILTER_KEYS = [
  "stops",
  "al",
  "xal",
  "dep",
  "deph",
  "arr",
  "arrh",
  "rdep",
  "rdeph",
  "rarr",
  "rarrh",
  "maxh",
  "maxlay",
  "minlay",
  "minself",
  "maxp",
  "maxt",
] as const;

const STORAGE_KEY = "tickets.flightFilters.v1";

/** Лише ключі фільтрів з рядка URL; порожньо — "". */
export function pickFilters(params: URLSearchParams | [string, string][]): string {
  const keys = new Set<string>(FLIGHT_FILTER_KEYS);
  const entries = params instanceof URLSearchParams ? [...params] : params;
  return new URLSearchParams(entries.filter(([k, v]) => keys.has(k) && v !== "")).toString();
}

export function readLocalFilters(): string {
  try {
    return pickFilters(new URLSearchParams(localStorage.getItem(STORAGE_KEY) ?? ""));
  } catch {
    return "";
  }
}

export function writeLocalFilters(value: string): void {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, value);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Приватний режим: збереження лише в профілі (якщо вхід виконано).
  }
}
