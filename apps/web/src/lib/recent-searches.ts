/**
 * Останні пошуки (модуль 20.3) — лише в цьому браузері (localStorage): маршрут, дати, люди,
 * основні фільтри — те саме, що в адресі сторінки результатів. З акаунтом повна історія —
 * у кабінеті («Історія»).
 */
export type RecentKind = "flights" | "stays" | "trip";
export type RecentSearch = { kind: RecentKind; params: string; title: string; at: string };

const KEY = "tickets.recentSearches";
export const MAX_RECENT = 6;
const PATHS: Record<RecentKind, string> = { flights: "/", stays: "/stays", trip: "/trip" };

export function recentHref(search: RecentSearch): string {
  return `${PATHS[search.kind]}?${search.params}`;
}

export function readRecent(): RecentSearch[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is RecentSearch =>
        typeof r === "object" &&
        r !== null &&
        (r.kind === "flights" || r.kind === "stays" || r.kind === "trip") &&
        typeof r.params === "string" &&
        typeof r.title === "string",
    );
  } catch {
    return [];
  }
}

/** Той самий пошук — нагору, без дублів; не більше MAX_RECENT. */
export function rememberSearch(search: Omit<RecentSearch, "at">, now = new Date()): void {
  const rest = readRecent().filter((r) => !(r.kind === search.kind && r.params === search.params));
  const next = [{ ...search, at: now.toISOString() }, ...rest].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // без сховища — просто без «останніх пошуків»
  }
}

export function clearRecent(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // нічого
  }
}
