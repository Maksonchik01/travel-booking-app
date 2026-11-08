import type { FavoriteStayInput, Stay, StayQuery } from "@tickets/shared";

/**
 * «В обране» (модуль 7): структурований знімок об'єкта й умов пошуку. Гість — у цьому браузері
 * (localStorage), з акаунтом — у профілі (після входу локальне переноситься туди). Ціна в знімку
 * — на момент збереження: UI підписує її датою, а актуальну показує лише новий пошук.
 */
export const MAX_FAVORITES = 200;
const STORAGE_KEY = "tickets.favorites.v1";

export type FavoriteItem = { item_key: string; created_at: string; stay: FavoriteStayInput };

export function favoriteKey(
  stay: Pick<FavoriteStayInput, "source" | "stay_id" | "check_in" | "check_out">,
): string {
  return `${stay.source}:${stay.stay_id}|${stay.check_in}|${stay.check_out}`;
}

/** Знімок для збереження: лише поля картки, без посилань продавців. */
export function favoriteSnapshot(stay: Stay, query: StayQuery, params: string): FavoriteStayInput {
  return {
    source: stay.source,
    stay_id: stay.id,
    name: stay.name,
    kind: stay.kind,
    city: query.city,
    district: stay.district ?? null,
    rating: stay.rating ?? null,
    review_count: stay.review_count ?? 0,
    price_per_night: stay.price_per_night,
    total_price: stay.total_price,
    currency: stay.currency,
    check_in: query.check_in,
    check_out: query.check_out,
    price_at: stay.found_at ?? stay.collected_at,
    params,
  };
}

function isItem(value: unknown): value is FavoriteItem {
  if (!value || typeof value !== "object") return false;
  const item = value as FavoriteItem;
  return (
    typeof item.item_key === "string" &&
    typeof item.created_at === "string" &&
    !!item.stay &&
    typeof item.stay.name === "string" &&
    typeof item.stay.total_price === "number"
  );
}

export function readLocalFavorites(): FavoriteItem[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isItem).slice(0, MAX_FAVORITES) : [];
  } catch {
    return [];
  }
}

export function writeLocalFavorites(items: FavoriteItem[]): void {
  try {
    if (items.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Приватний режим: обране — лише до перезавантаження (або в профілі).
  }
}
