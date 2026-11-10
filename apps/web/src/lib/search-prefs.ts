import type {
  Account,
  FlightPreferences,
  FlightPrefs,
  SearchPrefs,
  SearchPrefsInput,
  StayPreferences,
  TripPreferences,
  TripProfile,
  TripQuery,
} from "@tickets/shared";

import type { CommonSearch } from "@/lib/search-modes";
import {
  BAGGAGE_NEEDS,
  CABINS,
  DEPARTURE_PERIODS,
  MAX_STOPS_OPTIONS,
  PROFILES,
} from "@/lib/search-params";
import {
  AMENITIES,
  MAX_DISTANCE_OPTIONS,
  MIN_RATING_OPTIONS,
  STAY_KINDS,
  STAY_PROFILES,
} from "@/lib/stay-params";

/**
 * Особисті налаштування пошуку (модуль 10b, п. 10.7): значення за замовчуванням для НОВОГО
 * пошуку. Форма підставляє їх як початкові значення, фільтри — прихованими полями з
 * позначкою; конкретний пошук може їх змінити, а збережене в профілі лишається.
 */

const AIRLINE = /^[A-Z0-9]{2}$/;

function pick<T extends string | number>(value: FormDataEntryValue | null, options: readonly T[]) {
  const raw = String(value ?? "");
  return options.find((option) => String(option) === raw) ?? null;
}

function pickAll<T extends string>(form: FormData, key: string, options: readonly T[]): T[] {
  const values = form.getAll(key).map(String);
  return options.filter((option) => values.includes(option));
}

/** Форма налаштувань → тіло PUT /account/search-preferences. Биті значення відкидаємо. */
export function searchPrefsFromForm(form: FormData): SearchPrefsInput {
  const airlines = String(form.get("airlines") ?? "")
    .split(/[\s,]+/)
    .map((code) => code.trim().toUpperCase())
    .filter((code) => AIRLINE.test(code));
  return {
    flights: {
      cabin: pick(form.get("cabin"), CABINS),
      baggage: pick(form.get("bag"), BAGGAGE_NEEDS),
      max_stops: pick(form.get("stops"), MAX_STOPS_OPTIONS),
      airlines: [...new Set(airlines)].slice(0, 10),
      profile: pick(form.get("profile"), PROFILES),
      departure_periods: pickAll(form, "dep", DEPARTURE_PERIODS),
    },
    stays: {
      kinds: pickAll(form, "kind", STAY_KINDS),
      min_rating: pick(form.get("rating"), MIN_RATING_OPTIONS),
      max_distance_km: pick(form.get("dist"), MAX_DISTANCE_OPTIONS),
      amenities: pickAll(form, "am", AMENITIES),
      free_cancellation: form.get("cancel") === "1",
      profile: pick(form.get("prio"), STAY_PROFILES),
    },
  };
}

/** Фільтри перельотів з налаштувань — у тих самих ключах URL, що й видача. */
export function flightPrefFilters(prefs: SearchPrefs | null | undefined): [string, string][] {
  const f = prefs?.flights;
  if (!f) return [];
  const entries: [string, string][] = [];
  if (f.max_stops != null) entries.push(["stops", String(f.max_stops)]);
  if (f.airlines?.length) entries.push(["al", f.airlines.join(",")]);
  if (f.departure_periods?.length) entries.push(["dep", f.departure_periods.join(",")]);
  return entries;
}

/**
 * Уподобання з профілю як М'ЯКИЙ чинник скорингу (модуль 14.2): навіть коли фільтр з профілю
 * вимкнули в пошуку, бажані авіакомпанії й час вильоту трохи піднімають відповідні рейси.
 */
export function flightPreferences(
  prefs: SearchPrefs | null | undefined,
): FlightPreferences | undefined {
  const f = prefs?.flights;
  if (!f?.airlines?.length && !f?.departure_periods?.length) return undefined;
  return { airlines: f.airlines ?? [], departure_periods: f.departure_periods ?? [] };
}

/** Бажані зручності житла — м'який чинник оцінки (модуль 14.3), окремо від фільтра `am`. */
export function stayPreferences(
  prefs: SearchPrefs | null | undefined,
): StayPreferences | undefined {
  const amenities = prefs?.stays?.amenities ?? [];
  return amenities.length ? { amenities } : undefined;
}

/** Уподобання для поїздки цілком (модуль 14.4): ті самі, що для перельотів і житла окремо. */
export function tripPreferences(
  prefs: SearchPrefs | null | undefined,
): TripPreferences | undefined {
  const flights = flightPreferences(prefs);
  const stays = stayPreferences(prefs);
  return flights || stays ? { flights, stays } : undefined;
}

/**
 * Фільтри для нового пошуку: збережені «Зберегти налаштування» з видачі важать більше
 * (вони свіжіші й конкретніші), налаштування профілю доповнюють відсутні ключі.
 */
export function mergeFilters(saved: string | null, prefs: [string, string][]): string | null {
  const merged = new URLSearchParams(saved ?? "");
  for (const [key, value] of prefs) if (!merged.has(key)) merged.set(key, value);
  return merged.toString() || null;
}

/** Фільтри й пріоритет житла з налаштувань — ключі URL `/stays` (stay-params.ts). */
export function stayPrefParams(prefs: SearchPrefs | null | undefined): [string, string][] {
  const s = prefs?.stays;
  if (!s) return [];
  const entries: [string, string][] = [];
  if (s.kinds?.length) entries.push(["kind", s.kinds.join(",")]);
  if (s.min_rating != null) entries.push(["rating", String(s.min_rating)]);
  if (s.max_distance_km != null) entries.push(["dist", String(s.max_distance_km)]);
  if (s.amenities?.length) entries.push(["am", s.amenities.join(",")]);
  if (s.free_cancellation) entries.push(["cancel", "1"]);
  return entries;
}

/** Значення форми перельотів за замовчуванням (коли пошук новий, а не відкритий з URL). */
export type FlightDefaults = {
  origin?: string | null;
  /** Перенесене з іншого режиму (модуль 12.2): куди, дати, люди. */
  destination?: string;
  originAlso?: string[];
  destinationAlso?: string[];
  departure?: string;
  returnDate?: string;
  adults?: number;
  children?: number;
  cabin?: FlightPrefs["cabin"];
  baggage?: FlightPrefs["baggage"];
  currency?: string | null;
  profile?: FlightPrefs["profile"];
};

/** Домашній аеропорт — «звідки», валюта профілю, клас, багаж і пріоритет з налаштувань. */
export function flightDefaults(account: Account): FlightDefaults {
  const f = account.search_prefs?.flights;
  return {
    origin: account.home_airport,
    cabin: f?.cabin,
    baggage: f?.baggage,
    currency: account.currency,
    profile: f?.profile,
  };
}

/** Значення профілю + перенесене з іншого режиму (воно конкретніше — важить більше). */
export function withCarried(
  defaults: FlightDefaults | null,
  carried: CommonSearch | null,
): FlightDefaults | null {
  if (!carried || Object.keys(carried).length === 0) return defaults;
  return {
    ...defaults,
    origin: carried.from ?? defaults?.origin,
    destination: carried.to,
    originAlso: carried.fromAlso,
    destinationAlso: carried.toAlso,
    departure: carried.depart,
    returnDate: carried.return,
    adults: carried.adults,
    children: carried.children,
  };
}

const TRIP_PROFILE: Record<NonNullable<FlightPrefs["profile"]>, TripProfile> = {
  budget: "budget",
  balanced: "balanced",
  time_is_money: "comfort",
};

/**
 * Початкові значення форми поїздки з кабінету (модуль 15): домашній аеропорт, клас, багаж,
 * «лише прямі», пріоритет і умови житла — як і у формах перельотів і житла окремо.
 */
export function tripDefaults(account: Account): Partial<TripQuery> {
  const f = account.search_prefs?.flights;
  const s = account.search_prefs?.stays;
  const defaults: Partial<TripQuery> = {};
  if (account.home_airport) defaults.origin = account.home_airport;
  if (account.currency) defaults.currency = account.currency;
  if (f?.cabin) defaults.cabin = f.cabin;
  if (f?.baggage) defaults.baggage = f.baggage;
  if (f?.max_stops === 0) defaults.direct_only = true;
  if (f?.profile) defaults.profile = TRIP_PROFILE[f.profile];
  const stay = {
    ...(s?.min_rating != null && { min_rating: s.min_rating }),
    ...(s?.max_distance_km != null && { max_distance_center_km: s.max_distance_km }),
    ...(s?.free_cancellation && { free_cancellation: true }),
  };
  if (Object.keys(stay).length) defaults.stay_filters = stay as TripQuery["stay_filters"];
  return defaults;
}

/** Профіль + чернетка з іншого режиму: чернетка конкретніша — її значення важать більше. */
export function withTripDraft(
  defaults: Partial<TripQuery> | null,
  draft: Partial<TripQuery> | null,
): Partial<TripQuery> | null {
  if (!defaults) return draft;
  const defined = Object.fromEntries(
    Object.entries(draft ?? {}).filter(([, value]) => value !== undefined),
  );
  return { ...defaults, ...defined };
}
