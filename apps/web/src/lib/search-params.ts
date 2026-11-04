import type { DeparturePeriod, FlightQuery, OfferFilters, Profile } from "@tickets/shared";

export type RawSearchParams = Record<string, string | string[] | undefined>;
export type SortKey = "price" | "duration" | "score";
export const SORT_KEYS: readonly SortKey[] = ["price", "duration", "score"];

export type SearchState = {
  query: FlightQuery;
  sort: SortKey;
};

const IATA = /^[A-Za-z]{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_FLEX_DAYS = 7;
/** Радіус «сусідніх аеропортів» (≈ 2 год дороги). Бекенд дозволяє до 300 км. */
export const NEARBY_RADIUS_KM = 150;
export const PROFILES: readonly Profile[] = ["budget", "balanced", "time_is_money"];
export const DEPARTURE_PERIODS: readonly DeparturePeriod[] = [
  "night",
  "morning",
  "afternoon",
  "evening",
];
export const MAX_STOPS_OPTIONS = [0, 1, 2] as const;
export const MAX_DURATION_OPTIONS = [3, 5, 8, 12, 24] as const;
const AIRLINE = /^[A-Za-z0-9]{2}$/;
const MAX_AIRLINES = 20;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function intInRange(value: string | undefined, min: number, max: number, fallback: number) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function parseProfile(value: string | undefined): Profile {
  return PROFILES.find((p) => p === value) ?? "balanced";
}

function isValidDate(value: string | undefined): value is string {
  return !!value && ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** `al=FR,W6` (наш формат) і `al=FR&al=W6` (так шле форма з чекбоксами) — однаково. */
function list(value: string | string[] | undefined): string[] {
  const parts = Array.isArray(value) ? value : value ? [value] : [];
  return parts.flatMap((v) => v.split(",")).filter(Boolean);
}

/** Фільтри видачі з URL: биті значення відкидаємо, а не ламаємо пошук. */
function parseFilters(params: RawSearchParams): OfferFilters {
  const stops = Number.parseInt(first(params.stops) ?? "", 10);
  const hours = Number.parseInt(first(params.maxh) ?? "", 10);
  const airlines = [
    ...new Set(
      list(params.al)
        .filter((a) => AIRLINE.test(a))
        .map((a) => a.toUpperCase()),
    ),
  ].slice(0, MAX_AIRLINES);
  const periods = list(params.dep);
  return {
    max_stops: MAX_STOPS_OPTIONS.find((n) => n === stops) ?? null,
    airlines,
    departure_periods: DEPARTURE_PERIODS.filter((p) => periods.includes(p)),
    max_duration_hours: Number.isFinite(hours) && hours >= 1 && hours <= 72 ? hours : null,
  };
}

/** Фільтри → параметри URL (лише задані). */
export function filterParams(filters: OfferFilters | undefined): [string, string][] {
  const entries: [string, string][] = [];
  if (!filters) return entries;
  if (filters.max_stops != null) entries.push(["stops", String(filters.max_stops)]);
  if (filters.airlines?.length) entries.push(["al", filters.airlines.join(",")]);
  if (filters.departure_periods?.length) entries.push(["dep", filters.departure_periods.join(",")]);
  if (filters.max_duration_hours != null)
    entries.push(["maxh", String(filters.max_duration_hours)]);
  return entries;
}

export function hasFilters(filters: OfferFilters | undefined): boolean {
  return filterParams(filters).length > 0;
}

/** URL → валідний запит пошуку, або null, якщо пошук ще не задано чи параметри биті. */
export function parseSearchParams(params: RawSearchParams): SearchState | null {
  const origin = first(params.from)?.toUpperCase();
  const destination = first(params.to)?.toUpperCase();
  const departure = first(params.depart);
  const returnDate = first(params.return);

  if (!origin || !destination || !IATA.test(origin) || !IATA.test(destination)) return null;
  if (origin === destination || !isValidDate(departure)) return null;
  const validReturn = isValidDate(returnDate) && returnDate >= departure ? returnDate : null;

  return {
    query: {
      origin,
      destination,
      departure_date: departure,
      return_date: validReturn,
      flex_days: intInRange(first(params.flex), 0, MAX_FLEX_DAYS, 0),
      passengers: { adults: intInRange(first(params.adults), 1, 9, 1), children: 0, infants: 0 },
      direct_only: first(params.direct) === "1",
      currency: "EUR",
      profile: parseProfile(first(params.profile)),
      origin_radius_km: first(params.fromNear) === "1" ? NEARBY_RADIUS_KM : 0,
      destination_radius_km: first(params.toNear) === "1" ? NEARBY_RADIUS_KM : 0,
      filters: parseFilters(params),
    },
    sort: SORT_KEYS.find((k) => k === first(params.sort)) ?? "price",
  };
}

/** Запит → рядок URL (зворотна операція до parseSearchParams). */
export function toSearchParams(state: SearchState): URLSearchParams {
  const { query } = state;
  const params = new URLSearchParams({
    from: query.origin,
    to: query.destination,
    depart: query.departure_date,
  });
  if (query.return_date) params.set("return", query.return_date);
  if (query.flex_days) params.set("flex", String(query.flex_days));
  const adults = query.passengers?.adults ?? 1;
  if (adults > 1) params.set("adults", String(adults));
  if (query.direct_only) params.set("direct", "1");
  if (query.origin_radius_km) params.set("fromNear", "1");
  if (query.destination_radius_km) params.set("toNear", "1");
  if (query.profile && query.profile !== "balanced") params.set("profile", query.profile);
  if (state.sort !== "price") params.set("sort", state.sort);
  for (const [key, value] of filterParams(query.filters)) params.set(key, value);
  return params;
}

/** Зсуває виліт (і повернення — на ту саму тривалість поїздки) на нову дату. */
export function withDepartureDate(state: SearchState, departure: string): SearchState {
  const { query } = state;
  let returnDate = query.return_date ?? null;
  if (returnDate) {
    const tripDays = daysBetween(query.departure_date, returnDate);
    returnDate = addDays(departure, tripDays);
  }
  return {
    ...state,
    query: { ...query, departure_date: departure, return_date: returnDate },
  };
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
