import type { SearchKind } from "@tickets/shared";

/**
 * Збережені пошуки гостя (етап 7, ADR 0051): у цьому браузері (localStorage), до 50. Після входу —
 * пропозиція перенести в акаунт (`GuestImportPrompt`), повтори (вид + параметри) пропускаються.
 */
export const MAX_GUEST_SEARCHES = 50;
const STORAGE_KEY = "tickets.savedSearches.v1";

export type GuestSearch = { kind: SearchKind; params: string; title: string; saved_at: string };

function isSearch(value: unknown): value is GuestSearch {
  const v = value as GuestSearch;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.kind === "string" &&
    typeof v.params === "string" &&
    typeof v.title === "string"
  );
}

export function readGuestSearches(): GuestSearch[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isSearch).slice(0, MAX_GUEST_SEARCHES) : [];
  } catch {
    return [];
  }
}

export function writeGuestSearches(items: GuestSearch[]): void {
  try {
    if (items.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Приватний режим — без збереження.
  }
}

/** Зберегти пошук гостя; той самий (вид + параметри) — не дублюємо. Повертає, чи вдалося. */
export function saveGuestSearch(item: Omit<GuestSearch, "saved_at">): boolean {
  const items = readGuestSearches();
  if (items.some((i) => i.kind === item.kind && i.params === item.params)) return true;
  if (items.length >= MAX_GUEST_SEARCHES) return false;
  writeGuestSearches([{ ...item, saved_at: new Date().toISOString() }, ...items]);
  return true;
}
