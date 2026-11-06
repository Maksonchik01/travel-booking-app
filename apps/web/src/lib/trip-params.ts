import type { TripProfile, TripQuery } from "@tickets/shared";

import type { RawSearchParams } from "@/lib/search-params";
import { MAX_NIGHTS } from "@/lib/stay-params";

export const TRIP_PROFILES: readonly TripProfile[] = ["budget", "balanced", "comfort"];
export const MAX_TRIP_FLEX_DAYS = 3;

const IATA = /^[A-Za-z]{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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

/** URL `/trip?from=&to=&depart=&return=&adults=&children=&prio=&budget=&direct=&flex=`. */
export function parseTripParams(params: RawSearchParams): TripQuery | null {
  const origin = first(params.from)?.toUpperCase();
  const destination = first(params.to)?.toUpperCase();
  const departure = first(params.depart);
  const returnDate = first(params.return);
  if (!origin || !destination || !IATA.test(origin) || !IATA.test(destination)) return null;
  if (origin === destination || !isValidDate(departure) || !isValidDate(returnDate)) return null;
  const length = nights(departure, returnDate);
  if (length < 1 || length > MAX_NIGHTS) return null;
  const budget = Number.parseInt(first(params.budget) ?? "", 10);
  return {
    origin,
    destination,
    departure_date: departure,
    return_date: returnDate,
    flex_days: intInRange(first(params.flex), 0, MAX_TRIP_FLEX_DAYS, 0),
    adults: intInRange(first(params.adults), 1, 9, 2),
    children: intInRange(first(params.children), 0, 8, 0),
    direct_only: first(params.direct) === "1",
    profile: TRIP_PROFILES.find((p) => p === first(params.prio)) ?? "balanced",
    budget_total: Number.isFinite(budget) && budget > 0 && budget <= 1_000_000 ? budget : null,
    currency: "EUR",
  };
}

export function toTripParams(query: TripQuery): URLSearchParams {
  const params = new URLSearchParams({
    from: query.origin,
    to: query.destination,
    depart: query.departure_date,
    return: query.return_date,
  });
  if ((query.adults ?? 2) !== 2) params.set("adults", String(query.adults));
  if (query.children) params.set("children", String(query.children));
  if (query.flex_days) params.set("flex", String(query.flex_days));
  if (query.direct_only) params.set("direct", "1");
  if (query.profile && query.profile !== "balanced") params.set("prio", query.profile);
  if (query.budget_total != null) params.set("budget", String(query.budget_total));
  return params;
}
