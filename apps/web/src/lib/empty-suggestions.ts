import type { TripQuery } from "@tickets/shared";

import {
  hasFilters,
  NEARBY_RADIUS_KM,
  type SearchState,
  toSearchParams,
} from "@/lib/search-params";
import { hasStayFilters, type StayState, toStayParams } from "@/lib/stay-params";
import { toTripParams } from "@/lib/trip-params";

/**
 * Порожні результати (модуль 20.5): що можна послабити — кожна пропозиція окремим посиланням
 * з тим самим пошуком і ОДНІЄЮ зміною. Нічого не змінюємо автоматично: людина бачить, що саме
 * зміниться, і вирішує сама (обов'язкові умови — її).
 */
export type SuggestionKey =
  "widerDates" | "allowStops" | "nearby" | "higherBudget" | "fewerFilters" | "widerArea";
export type Suggestion = { key: SuggestionKey; href: string; amount?: number };

const WIDER_FLEX = 3;
/** «Збільшити бюджет» — на чверть, до цілих. */
const raise = (value: number) => Math.ceil(value * 1.25);

export function flightSuggestions(state: SearchState): Suggestion[] {
  const q = state.query;
  const f = q.filters ?? {};
  const href = (query: SearchState["query"]) => `/?${toSearchParams({ ...state, query })}`;
  const out: Suggestion[] = [];
  if (!q.departure_until && (q.flex_days ?? 0) < WIDER_FLEX) {
    out.push({ key: "widerDates", href: href({ ...q, flex_days: WIDER_FLEX }) });
  }
  if (q.direct_only || f.max_stops === 0) {
    out.push({
      key: "allowStops",
      href: href({ ...q, direct_only: false, filters: { ...f, max_stops: null } }),
    });
  }
  if (!q.origin_radius_km || !q.destination_radius_km) {
    out.push({
      key: "nearby",
      href: href({
        ...q,
        origin_radius_km: NEARBY_RADIUS_KM,
        destination_radius_km: NEARBY_RADIUS_KM,
      }),
    });
  }
  if (f.max_price != null) {
    const amount = raise(f.max_price);
    out.push({
      key: "higherBudget",
      amount,
      href: href({ ...q, filters: { ...f, max_price: amount } }),
    });
  } else if (f.max_total_price != null) {
    const amount = raise(f.max_total_price);
    out.push({
      key: "higherBudget",
      amount,
      href: href({ ...q, filters: { ...f, max_total_price: amount } }),
    });
  }
  if (hasFilters(f)) out.push({ key: "fewerFilters", href: href({ ...q, filters: {} }) });
  return out;
}

export function staySuggestions(state: StayState): Suggestion[] {
  const q = state.query;
  const f = q.filters ?? {};
  const href = (query: StayState["query"]) => `/stays?${toStayParams({ ...state, query })}`;
  const out: Suggestion[] = [];
  if (f.max_distance_center_km != null || f.radius_km != null || f.districts?.length) {
    out.push({
      key: "widerArea",
      href: href({
        ...q,
        filters: { ...f, max_distance_center_km: null, radius_km: null, districts: [] },
      }),
    });
  }
  if (f.max_price_per_night != null) {
    const amount = raise(f.max_price_per_night);
    out.push({
      key: "higherBudget",
      amount,
      href: href({ ...q, filters: { ...f, max_price_per_night: amount } }),
    });
  } else if (f.max_total_price != null) {
    const amount = raise(f.max_total_price);
    out.push({
      key: "higherBudget",
      amount,
      href: href({ ...q, filters: { ...f, max_total_price: amount } }),
    });
  }
  if (hasStayFilters(f)) {
    out.push({
      key: "fewerFilters",
      href: href({
        ...q,
        filters: {
          free_cancellation: false,
          breakfast_included: false,
          no_prepayment: false,
          pay_at_property: false,
        },
      }),
    });
  }
  return out;
}

export function tripSuggestions(query: TripQuery): Suggestion[] {
  const href = (q: TripQuery) => `/trip?${toTripParams(q)}`;
  const out: Suggestion[] = [];
  const nights = query.min_nights != null && query.max_nights != null;
  if (!query.departure_until && !nights && (query.flex_days ?? 0) < WIDER_FLEX) {
    out.push({ key: "widerDates", href: href({ ...query, flex_days: WIDER_FLEX }) });
  }
  if (query.direct_only)
    out.push({ key: "allowStops", href: href({ ...query, direct_only: false }) });
  if (!query.nearby) out.push({ key: "nearby", href: href({ ...query, nearby: true }) });
  const stay = query.stay_filters;
  if (
    stay?.min_rating != null ||
    stay?.free_cancellation ||
    stay?.breakfast_included ||
    stay?.max_distance_center_km != null
  ) {
    out.push({
      key: "fewerFilters",
      href: href({
        ...query,
        stay_filters: {
          free_cancellation: false,
          breakfast_included: false,
          no_prepayment: false,
          pay_at_property: false,
        },
      }),
    });
  }
  return out;
}
