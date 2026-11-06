import type { StayFilters, StayKind, StayProfile, StayQuery } from "@tickets/shared";

import { addDays, type RawSearchParams } from "@/lib/search-params";

export type StaySortKey = "price" | "rating" | "score";
export const STAY_SORT_KEYS: readonly StaySortKey[] = ["price", "rating", "score"];
export const STAY_PROFILES: readonly StayProfile[] = ["budget", "balanced", "center"];
export const STAY_KINDS: readonly StayKind[] = ["hotel", "apartment", "guesthouse", "hostel"];
export const MIN_RATING_OPTIONS = [7, 8, 9] as const;
export const MAX_NIGHTS = 30;

export type StayState = {
  query: StayQuery;
  sort: StaySortKey;
};

const IATA = /^[A-Za-z]{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function list(value: string | string[] | undefined): string[] {
  const parts = Array.isArray(value) ? value : value ? [value] : [];
  return parts.flatMap((v) => v.split(",")).filter(Boolean);
}

function intInRange(value: string | undefined, min: number, max: number, fallback: number) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function isValidDate(value: string | undefined): value is string {
  return !!value && ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** Фільтри з URL: биті значення відкидаємо, а не ламаємо пошук. */
function parseStayFilters(params: RawSearchParams): StayFilters {
  const price = Number.parseInt(first(params.maxp) ?? "", 10);
  const rating = Number.parseInt(first(params.rating) ?? "", 10);
  const kinds = list(params.kind);
  return {
    max_price_per_night: Number.isFinite(price) && price > 0 && price <= 100_000 ? price : null,
    min_rating: MIN_RATING_OPTIONS.find((r) => r === rating) ?? null,
    free_cancellation: first(params.cancel) === "1",
    kinds: STAY_KINDS.filter((k) => kinds.includes(k)),
  };
}

export function stayFilterParams(filters: StayFilters | undefined): [string, string][] {
  const entries: [string, string][] = [];
  if (!filters) return entries;
  if (filters.max_price_per_night != null)
    entries.push(["maxp", String(filters.max_price_per_night)]);
  if (filters.min_rating != null) entries.push(["rating", String(filters.min_rating)]);
  if (filters.free_cancellation) entries.push(["cancel", "1"]);
  if (filters.kinds?.length) entries.push(["kind", filters.kinds.join(",")]);
  return entries;
}

export function hasStayFilters(filters: StayFilters | undefined): boolean {
  return stayFilterParams(filters).length > 0;
}

/** URL `/stays?city=&in=&out=&adults=&children=&prio=&sort=` → запит або null. */
export function parseStayParams(params: RawSearchParams): StayState | null {
  const city = first(params.city)?.toUpperCase();
  const checkIn = first(params.in);
  const checkOut = first(params.out);
  if (!city || !IATA.test(city) || !isValidDate(checkIn) || !isValidDate(checkOut)) return null;
  if (checkOut <= checkIn || checkOut > addDays(checkIn, MAX_NIGHTS)) return null;
  return {
    query: {
      city,
      check_in: checkIn,
      check_out: checkOut,
      guests: {
        adults: intInRange(first(params.adults), 1, 9, 2),
        children: intInRange(first(params.children), 0, 8, 0),
      },
      currency: "EUR",
      profile: STAY_PROFILES.find((p) => p === first(params.prio)) ?? "balanced",
      filters: parseStayFilters(params),
    },
    sort: STAY_SORT_KEYS.find((k) => k === first(params.sort)) ?? "price",
  };
}

export function toStayParams(state: StayState): URLSearchParams {
  const { query } = state;
  const params = new URLSearchParams({
    city: query.city,
    in: query.check_in,
    out: query.check_out,
  });
  const adults = query.guests?.adults ?? 2;
  const children = query.guests?.children ?? 0;
  if (adults !== 2) params.set("adults", String(adults));
  if (children) params.set("children", String(children));
  if (query.profile && query.profile !== "balanced") params.set("prio", query.profile);
  if (state.sort !== "price") params.set("sort", state.sort);
  for (const [key, value] of stayFilterParams(query.filters)) params.set(key, value);
  return params;
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round(
    (Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000,
  );
}
