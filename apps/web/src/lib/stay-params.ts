import type {
  Amenity,
  Guests,
  StayFilters,
  StayKind,
  StayProfile,
  StayQuery,
} from "@tickets/shared";

import { addDays, type RawSearchParams } from "@/lib/search-params";

export type StaySortKey = "price" | "rating" | "score";
export const STAY_SORT_KEYS: readonly StaySortKey[] = ["price", "rating", "score"];
export const STAY_PROFILES: readonly StayProfile[] = ["budget", "balanced", "center"];
export const STAY_KINDS: readonly StayKind[] = [
  "hotel",
  "apartment",
  "guesthouse",
  "hostel",
  "other",
];
export const AMENITIES: readonly Amenity[] = [
  "wifi",
  "parking",
  "air_conditioning",
  "kitchen",
  "pool",
  "spa",
  "gym",
  "balcony",
  "breakfast",
  "pets",
  "airport_shuttle",
];
export const MAX_ROOMS = 5;
export const MAX_DISTANCE_OPTIONS = [1, 2, 3, 5, 10] as const;
export const RADIUS_OPTIONS = [1, 3, 5, 10] as const;
export const MIN_BEDS_OPTIONS = [1, 2, 3, 4, 6] as const;
export const MIN_RATING_OPTIONS = [7, 8, 9] as const;
export const MAX_NIGHTS = 30;

export type StayView = "list" | "map";

export type StayState = {
  query: StayQuery;
  sort: StaySortKey;
  /** Список чи карта (модуль 6); на широкому екрані «карта» — список і карта поруч. */
  view?: StayView;
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
function money(value: string | undefined, max: number): number | null {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 && n <= max ? n : null;
}

function oneOf<T extends number>(value: string | undefined, options: readonly T[]): T | null {
  const n = Number.parseFloat(value ?? "");
  return options.find((o) => o === n) ?? null;
}

/** `near=38.72,-9.14` — координати точки (широта, довгота). */
function point(value: string | undefined): { lat: number; lon: number } | null {
  const [lat, lon] = (value ?? "").split(",").map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function parseStayFilters(params: RawSearchParams): StayFilters {
  const rating = Number.parseInt(first(params.rating) ?? "", 10);
  const kinds = list(params.kind);
  const amenities = list(params.am);
  const airport = first(params.nearap)?.toUpperCase();
  return {
    min_price_per_night: money(first(params.minp), 100_000),
    max_price_per_night: money(first(params.maxp), 100_000),
    min_total_price: money(first(params.mint), 1_000_000),
    max_total_price: money(first(params.maxt), 1_000_000),
    min_rating: MIN_RATING_OPTIONS.find((r) => r === rating) ?? null,
    free_cancellation: first(params.cancel) === "1",
    breakfast_included: first(params.bfast) === "1",
    no_prepayment: first(params.noprepay) === "1",
    pay_at_property: first(params.payprop) === "1",
    kinds: STAY_KINDS.filter((k) => kinds.includes(k)),
    amenities: AMENITIES.filter((a) => amenities.includes(a)),
    min_beds: oneOf(first(params.beds), MIN_BEDS_OPTIONS),
    max_distance_center_km: oneOf(first(params.dist), MAX_DISTANCE_OPTIONS),
    districts: list(params.district).slice(0, 20),
    near: point(first(params.near)),
    near_airport: airport && IATA.test(airport) ? airport : null,
    radius_km: oneOf(first(params.radius), RADIUS_OPTIONS),
    bbox: bbox(first(params.bbox)),
  };
}

/** `bbox=півд,зах,півн,сх` — видима область карти («Шукати в цій області»). */
function bbox(value: string | undefined) {
  const parts = (value ?? "").split(",").map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return null;
  const [south, west, north, east] = parts;
  if (south >= north || Math.abs(south) > 90 || Math.abs(north) > 90) return null;
  if (Math.abs(west) > 180 || Math.abs(east) > 180) return null;
  return { south, west, north, east };
}

/** Межі області для URL: 4 знаки після коми (~10 м) — коротко й досить точно. */
export function bboxParam(b: { south: number; west: number; north: number; east: number }) {
  return [b.south, b.west, b.north, b.east].map((n) => n.toFixed(4)).join(",");
}

/** Гості: дорослі, діти з віком (`ages=3,9`, лише якщо їх стільки, скільки дітей), кімнати. */
function parseGuests(params: RawSearchParams): Guests {
  const adults = intInRange(first(params.adults), 1, 9, 2);
  const children = intInRange(first(params.children), 0, 8, 0);
  const ages = list(params.ages).map((a) => Number.parseInt(a, 10));
  const validAges =
    ages.length === children && ages.every((a) => Number.isInteger(a) && a >= 0 && a <= 17);
  return {
    adults,
    children,
    children_ages: validAges ? ages : [],
    rooms: Math.min(intInRange(first(params.rooms), 1, MAX_ROOMS, 1), adults + children),
  };
}

export function stayFilterParams(filters: StayFilters | undefined): [string, string][] {
  const entries: [string, string][] = [];
  if (!filters) return entries;
  const num = (key: string, value: number | null | undefined) => {
    if (value != null) entries.push([key, String(value)]);
  };
  num("minp", filters.min_price_per_night);
  num("maxp", filters.max_price_per_night);
  num("mint", filters.min_total_price);
  num("maxt", filters.max_total_price);
  num("rating", filters.min_rating);
  if (filters.free_cancellation) entries.push(["cancel", "1"]);
  if (filters.breakfast_included) entries.push(["bfast", "1"]);
  if (filters.no_prepayment) entries.push(["noprepay", "1"]);
  if (filters.pay_at_property) entries.push(["payprop", "1"]);
  if (filters.kinds?.length) entries.push(["kind", filters.kinds.join(",")]);
  if (filters.amenities?.length) entries.push(["am", filters.amenities.join(",")]);
  num("beds", filters.min_beds);
  num("dist", filters.max_distance_center_km);
  if (filters.districts?.length) entries.push(["district", filters.districts.join(",")]);
  if (filters.near) entries.push(["near", `${filters.near.lat},${filters.near.lon}`]);
  if (filters.near_airport) entries.push(["nearap", filters.near_airport]);
  num("radius", filters.radius_km);
  if (filters.bbox) entries.push(["bbox", bboxParam(filters.bbox)]);
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
      guests: parseGuests(params),
      currency: "EUR",
      profile: STAY_PROFILES.find((p) => p === first(params.prio)) ?? "balanced",
      filters: parseStayFilters(params),
    },
    sort: STAY_SORT_KEYS.find((k) => k === first(params.sort)) ?? "price",
    view: first(params.view) === "map" ? "map" : "list",
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
  if (query.guests?.children_ages?.length) params.set("ages", query.guests.children_ages.join(","));
  if ((query.guests?.rooms ?? 1) > 1) params.set("rooms", String(query.guests?.rooms));
  if (query.profile && query.profile !== "balanced") params.set("prio", query.profile);
  if (state.sort !== "price") params.set("sort", state.sort);
  for (const [key, value] of stayFilterParams(query.filters)) params.set(key, value);
  if (state.view === "map") params.set("view", "map");
  return params;
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round(
    (Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000,
  );
}
