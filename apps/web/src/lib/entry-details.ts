import type { SearchKind } from "@tickets/shared";

import { filterParams, parseSearchParams, passengerTotal } from "@/lib/search-params";
import { parseStayParams, stayFilterParams } from "@/lib/stay-params";
import { parseTripParams } from "@/lib/trip-params";

/**
 * Параметри запису історії (модуль 10b, п. 10.5) — для перегляду в кабінеті без повторного
 * пошуку. Рядок URL розбирають ті самі парсери, що й сторінки результатів.
 */
export type EntryDetails = {
  route: string;
  dates: { from: string; to: string | null };
  adults: number;
  children: number;
  rooms?: number;
  cabin?: string;
  baggage?: string;
  budget?: number | null;
  /** Фільтри видачі в ключах URL (stops, al, dep, rating, kind…). */
  filters: [string, string][];
};

export function entryDetails(kind: SearchKind, params: string): EntryDetails | null {
  const raw = Object.fromEntries(
    [...new URLSearchParams(params)].reduce((map, [key, value]) => {
      map.set(key, [...(map.get(key) ?? []), value]);
      return map;
    }, new Map<string, string[]>()),
  );
  if (kind === "flights") {
    const state = parseSearchParams(raw);
    if (!state) return null;
    const q = state.query;
    const adults = q.passengers?.adults ?? 1;
    return {
      route: `${q.origin} → ${q.destination}`,
      dates: { from: q.departure_date, to: q.return_date ?? null },
      adults,
      children: passengerTotal(q.passengers) - adults,
      cabin: q.cabin && q.cabin !== "economy" ? q.cabin : undefined,
      baggage: q.baggage && q.baggage !== "none" ? q.baggage : undefined,
      filters: filterParams(q.filters),
    };
  }
  if (kind === "stays") {
    const state = parseStayParams(raw);
    if (!state) return null;
    const q = state.query;
    return {
      route: q.city,
      dates: { from: q.check_in, to: q.check_out },
      adults: q.guests?.adults ?? 2,
      children: q.guests?.children ?? 0,
      rooms: q.guests?.rooms ?? 1,
      filters: stayFilterParams(q.filters).filter(([key]) => key !== "bbox"),
    };
  }
  const trip = parseTripParams(raw);
  if (!trip) return null;
  return {
    route: `${trip.origin} → ${trip.destination}`,
    dates: { from: trip.departure_date, to: trip.return_date ?? null },
    adults: trip.adults ?? 2,
    children: trip.children ?? 0,
    cabin: trip.cabin && trip.cabin !== "economy" ? trip.cabin : undefined,
    baggage: trip.baggage && trip.baggage !== "none" ? trip.baggage : undefined,
    budget: trip.budget_total,
    filters: trip.direct_only ? [["stops", "0"]] : [],
  };
}
