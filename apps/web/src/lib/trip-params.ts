import type { TripProfile, TripQuery } from "@tickets/shared";

import { BAGGAGE_NEEDS, CABINS, MAX_PERIOD_DAYS, type RawSearchParams } from "@/lib/search-params";
import { MAX_NIGHTS } from "@/lib/stay-params";

export const TRIP_PROFILES: readonly TripProfile[] = ["budget", "balanced", "comfort"];
export const MAX_TRIP_FLEX_DAYS = 3;

const IATA = /^[A-Za-z]{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Ключ житла `source:id` («Додати до поїздки», модуль 7) — як TripQuery.stay в API. */
const STAY_KEY = /^[a-z0-9_]{1,32}:[\w.-]{1,128}$/;
/** Ключ рейсу `source:id` (заміна перельоту, модуль 8b) — як TripQuery.flight в API. */
const OFFER_KEY = /^[a-z0-9_]{1,32}:[\w.-]{1,64}$/;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function intInRange(value: string | undefined, min: number, max: number, fallback: number) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function isValidDate(value: string | undefined): value is string {
  return !!value && ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function nights(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function stayKey(value: string | undefined): string | null {
  return value && STAY_KEY.test(value) ? value : null;
}

function flightKey(value: string | undefined): string | null {
  return value && OFFER_KEY.test(value) ? value : null;
}

export type TripExtra = NonNullable<TripQuery["extras"]>[number];
export const MAX_EXTRAS = 5;
export const TRIP_RATINGS = [7, 8, 9] as const;
export const TRIP_DISTANCES = [1, 3, 5] as const;
const NO_STAY_FILTERS = {
  free_cancellation: false,
  breakfast_included: false,
  no_prepayment: false,
  pay_at_property: false,
};

function all(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/** Власні витрати: пари `xl` (назва) і `xa` (сума) у тому ж порядку; порожні пропускаємо. */
function parseExtras(params: RawSearchParams): TripExtra[] {
  const labels = all(params.xl);
  const amounts = all(params.xa);
  return labels
    .map((label, i) => ({ label: label.trim().slice(0, 40), amount: Number(amounts[i]) }))
    .filter((e) => e.label && Number.isFinite(e.amount) && e.amount >= 0 && e.amount <= 100_000)
    .slice(0, MAX_EXTRAS);
}

/**
 * URL `/trip?from=&to=&depart=&return=&until=&nmin=&nmax=&flex=&adults=&children=&prio=&budget=`
 * `&direct=&near=&bag=&cabin=&rating=&cancel=&bfast=&dist=&xl=&xa=&stay=&flight=`. Тривалість
 * (`nmin`/`nmax`, ночі від дати прильоту) замінює дату повернення; `until` — гнучкий період
 * вильоту; `flight`/`stay` — вибір людини («Ваша поїздка», модуль 8b).
 */
export function parseTripParams(params: RawSearchParams): TripQuery | null {
  const origin = first(params.from)?.toUpperCase();
  const destination = first(params.to)?.toUpperCase();
  const departure = first(params.depart);
  if (!origin || !destination || !IATA.test(origin) || !IATA.test(destination)) return null;
  if (origin === destination || !isValidDate(departure)) return null;

  const nmin = Number.parseInt(first(params.nmin) ?? "", 10);
  const nmax = Number.parseInt(first(params.nmax) ?? "", 10);
  const duration =
    nmin >= 1 && nmax >= nmin && nmax <= MAX_NIGHTS ? { min: nmin, max: nmax } : null;
  const returnRaw = first(params.return);
  let returnDate: string | null = null;
  if (!duration) {
    if (!isValidDate(returnRaw)) return null;
    const length = nights(departure, returnRaw);
    if (length < 1 || length > MAX_NIGHTS) return null;
    returnDate = returnRaw;
  }
  const untilRaw = first(params.until);
  const span = isValidDate(untilRaw) ? nights(departure, untilRaw) : -1;
  const until = span >= 0 && span <= MAX_PERIOD_DAYS ? untilRaw! : null;

  const budget = Number.parseInt(first(params.budget) ?? "", 10);
  const rating = Number(first(params.rating));
  const distance = Number(first(params.dist));
  return {
    origin,
    destination,
    departure_date: departure,
    return_date: returnDate,
    departure_until: until,
    flex_days: until ? 0 : intInRange(first(params.flex), 0, MAX_TRIP_FLEX_DAYS, 0),
    min_nights: duration?.min ?? null,
    max_nights: duration?.max ?? null,
    adults: intInRange(first(params.adults), 1, 9, 2),
    children: intInRange(first(params.children), 0, 8, 0),
    direct_only: first(params.direct) === "1",
    nearby: first(params.near) === "1",
    cabin: CABINS.find((c) => c === first(params.cabin)) ?? "economy",
    baggage: BAGGAGE_NEEDS.find((b) => b === first(params.bag)) ?? "none",
    stay_filters: {
      ...NO_STAY_FILTERS,
      min_rating: TRIP_RATINGS.find((r) => r === rating) ?? null,
      free_cancellation: first(params.cancel) === "1",
      breakfast_included: first(params.bfast) === "1",
      max_distance_center_km: TRIP_DISTANCES.find((d) => d === distance) ?? null,
    },
    profile: TRIP_PROFILES.find((p) => p === first(params.prio)) ?? "balanced",
    budget_total: Number.isFinite(budget) && budget > 0 && budget <= 1_000_000 ? budget : null,
    extras: parseExtras(params),
    currency: "EUR",
    stay: stayKey(first(params.stay)),
    flight: flightKey(first(params.flight)),
  };
}

/**
 * Неповний запит для форми — напр. «Додати до поїздки» з житла: куди, дати, люди й житло
 * відомі, а місто вильоту — ні. Лише перевірені значення.
 */
export function parseTripDraft(params: RawSearchParams): Partial<TripQuery> | null {
  const origin = first(params.from)?.toUpperCase();
  const destination = first(params.to)?.toUpperCase();
  const departure = first(params.depart);
  const returnDate = first(params.return);
  const draft: Partial<TripQuery> = {
    origin: origin && IATA.test(origin) ? origin : undefined,
    destination: destination && IATA.test(destination) ? destination : undefined,
    departure_date: isValidDate(departure) ? departure : undefined,
    return_date: isValidDate(returnDate) ? returnDate : undefined,
    adults: intInRange(first(params.adults), 1, 9, 2),
    children: intInRange(first(params.children), 0, 8, 0),
    stay: stayKey(first(params.stay)),
  };
  return draft.destination || draft.stay ? draft : null;
}

export function toTripParams(query: TripQuery): URLSearchParams {
  const params = new URLSearchParams({
    from: query.origin,
    to: query.destination,
    depart: query.departure_date,
  });
  if (query.min_nights != null && query.max_nights != null) {
    params.set("nmin", String(query.min_nights));
    params.set("nmax", String(query.max_nights));
  } else if (query.return_date) {
    params.set("return", query.return_date);
  }
  if (query.departure_until) params.set("until", query.departure_until);
  if ((query.adults ?? 2) !== 2) params.set("adults", String(query.adults));
  if (query.children) params.set("children", String(query.children));
  if (query.flex_days) params.set("flex", String(query.flex_days));
  if (query.direct_only) params.set("direct", "1");
  if (query.nearby) params.set("near", "1");
  if (query.baggage && query.baggage !== "none") params.set("bag", query.baggage);
  if (query.cabin && query.cabin !== "economy") params.set("cabin", query.cabin);
  const stay = query.stay_filters;
  if (stay?.min_rating != null) params.set("rating", String(stay.min_rating));
  if (stay?.free_cancellation) params.set("cancel", "1");
  if (stay?.breakfast_included) params.set("bfast", "1");
  if (stay?.max_distance_center_km != null) params.set("dist", String(stay.max_distance_center_km));
  if (query.profile && query.profile !== "balanced") params.set("prio", query.profile);
  if (query.budget_total != null) params.set("budget", String(query.budget_total));
  for (const extra of query.extras ?? []) {
    params.append("xl", extra.label);
    params.append("xa", String(extra.amount));
  }
  if (query.stay) params.set("stay", query.stay);
  if (query.flight) params.set("flight", query.flight);
  return params;
}

/** Id збереженої поїздки, яку редагують (`saved=`): лише літери, цифри, «-». */
export function savedId(params: RawSearchParams): string | null {
  const value = first(params.saved);
  return value && /^[\w-]{1,64}$/.test(value) ? value : null;
}

/**
 * Та сама поїздка з іншим вибором рейсу чи житла (null — прибрати вибір). `saved` — режим
 * редагування збереженої поїздки переживає кожну зміну.
 */
export function withChoice(
  query: TripQuery,
  choice: { flight?: string | null; stay?: string | null },
  saved?: string | null,
): string {
  const params = toTripParams({ ...query, ...choice });
  if (saved) params.set("saved", saved);
  return `/trip?${params}`;
}
