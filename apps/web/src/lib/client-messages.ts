/**
 * Розділи перекладів, які потрібні в браузері (модуль 17.5): лише ті, що читає клієнтський код
 * (компоненти "use client" і все, що вони імпортують). Решту — юридичні тексти, сторінки
 * лише сервера — у браузер не надсилаємо: це ~45 % словника на кожній сторінці.
 * Повноту списку перевіряє client-messages.test.ts (обходить імпорти клієнтського коду).
 */
export const CLIENT_NAMESPACES = [
  "account",
  "ai",
  "alerts",
  "auth",
  "authErrors",
  "chatCards",
  "explore",
  "common",
  "compare",
  "currency",
  "favorites",
  "filters",
  "freshness",
  "modes",
  "nav",
  "offer",
  "picks",
  "recent",
  "results",
  "saveSearch",
  "savedTrips",
  "search",
  "sellers",
  "share",
  "stayAnalysis",
  "stayCard",
  "stayFilters",
  "stayHotel",
  "stayMap",
  "stayPicks",
  "stayRates",
  "stays",
  "tripBuilder",
  "tripCompare",
  "tripForm",
] as const;

export function clientMessages<M extends Record<string, unknown>>(messages: M): Partial<M> {
  return Object.fromEntries(
    CLIENT_NAMESPACES.filter((ns) => ns in messages).map((ns) => [ns, messages[ns]]),
  ) as Partial<M>;
}
