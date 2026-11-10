import type {
  BaggageNeed,
  HourRange,
  Cabin,
  DeparturePeriod,
  FlightQuery,
  OfferFilters,
  Passengers,
  Profile,
} from "@tickets/shared";

export type RawSearchParams = Record<string, string | string[] | undefined>;
export type SortKey = "price" | "duration" | "departure" | "score";
export const SORT_KEYS: readonly SortKey[] = ["price", "duration", "departure", "score"];

export type SearchState = {
  query: FlightQuery;
  sort: SortKey;
};

const IATA = /^[A-Za-z]{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_FLEX_DAYS = 7;
/** Режими гнучкості у формі (модуль 2a): ±дні, увесь місяць, свій період. */
export const FLEX_OPTIONS = [0, 1, 3, 7] as const;
export const MAX_PERIOD_DAYS = 62;
/** Ночей на місці для пошуку за тривалістю (як MAX_NIGHTS в API). */
export const MAX_NIGHTS = 30;
/** Радіус «сусідніх аеропортів» (≈ 2 год дороги). Бекенд дозволяє до 300 км. */
export const NEARBY_RADIUS_KM = 150;
export const PROFILES: readonly Profile[] = ["budget", "balanced", "time_is_money"];
export const DEPARTURE_PERIODS: readonly DeparturePeriod[] = [
  "night",
  "morning",
  "afternoon",
  "evening",
];
/** Валюти пошуку: для них є курс ЄЦБ, тож скоринг працює (ADR 0005, providers/fx.py). */
export const CURRENCIES = ["EUR", "USD", "GBP", "PLN"] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Валюта пошуку з URL (`cur=`) — спільна для перельотів, житла й поїздки (модуль 18.2). */
export function parseCurrency(params: RawSearchParams): Currency {
  return CURRENCIES.find((c) => c === first(params.cur)?.toUpperCase()) ?? "EUR";
}
export const CABINS: readonly Cabin[] = ["economy", "premium_economy", "business", "first"];
export const BAGGAGE_NEEDS: readonly BaggageNeed[] = [
  "none",
  "personal_item",
  "carry_on",
  "checked",
  "checked_extra",
];
/** Як у Passengers (API): до 9 пасажирів, немовля на руках — одне на дорослого. */
export const MAX_PASSENGERS = 9;
export const MAX_STOPS_OPTIONS = [0, 1, 2] as const;
export const MAX_DURATION_OPTIONS = [3, 5, 8, 12, 24] as const;
export const MAX_LAYOVER_OPTIONS = [2, 4, 6, 10, 16] as const;
export const MIN_LAYOVER_OPTIONS = [45, 60, 90, 120] as const;
export const MIN_SELF_TRANSFER_OPTIONS = [120, 180, 240] as const;
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

/** До скількох місць з кожного боку (основне + додаткові, модуль 2). */
export const MAX_PLACES = 4;

/** `from=AMS&from=RTM` (форма з кількома полями) чи `from=AMS,RTM` → коди без повторів. */
export function placeCodes(value: string | string[] | undefined): string[] {
  const codes = list(value)
    .map((code) => code.trim().toUpperCase())
    .filter((code) => IATA.test(code));
  return [...new Set(codes)].slice(0, MAX_PLACES);
}

function airlineList(value: string | string[] | undefined): string[] {
  return [
    ...new Set(
      list(value)
        .filter((a) => AIRLINE.test(a))
        .map((a) => a.toUpperCase()),
    ),
  ].slice(0, MAX_AIRLINES);
}

function periodList(value: string | string[] | undefined): DeparturePeriod[] {
  const values = list(value);
  return DEPARTURE_PERIODS.filter((p) => values.includes(p));
}

function oneOf<T extends number>(value: string | undefined, options: readonly T[]): T | null {
  const n = Number.parseInt(value ?? "", 10);
  return options.find((o) => o === n) ?? null;
}

/**
 * Власний діапазон годин: `deph=21-2` (наш формат) або `dephFrom=21&dephTo=2` (так шле форма
 * без JS). Порожній чи битий — немає діапазону.
 */
function hourRange(params: RawSearchParams, key: string): HourRange | null {
  const raw = first(params[key]);
  const [from, to] = raw
    ? raw.split("-")
    : [first(params[`${key}From`]), first(params[`${key}To`])];
  const start = Number.parseInt(from ?? "", 10);
  const end = Number.parseInt(to ?? "", 10);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || start > 23 || end < 0 || end > 24 || start === end % 24) return null;
  return { start, end };
}

/** Фільтри видачі з URL: биті значення відкидаємо, а не ламаємо пошук. */
function parseFilters(params: RawSearchParams): OfferFilters {
  const stops = Number.parseInt(first(params.stops) ?? "", 10);
  const hours = Number.parseInt(first(params.maxh) ?? "", 10);
  const price = Number.parseInt(first(params.maxp) ?? "", 10);
  const airlines = airlineList(params.al);
  const total = Number.parseInt(first(params.maxt) ?? "", 10);
  return {
    max_stops: MAX_STOPS_OPTIONS.find((n) => n === stops) ?? null,
    airlines,
    excluded_airlines: airlineList(params.xal),
    departure_periods: periodList(params.dep),
    departure_hours: hourRange(params, "deph"),
    arrival_periods: periodList(params.arr),
    arrival_hours: hourRange(params, "arrh"),
    return_departure_periods: periodList(params.rdep),
    return_departure_hours: hourRange(params, "rdeph"),
    return_arrival_periods: periodList(params.rarr),
    return_arrival_hours: hourRange(params, "rarrh"),
    max_duration_hours: Number.isFinite(hours) && hours >= 1 && hours <= 72 ? hours : null,
    max_layover_hours: oneOf(first(params.maxlay), MAX_LAYOVER_OPTIONS),
    min_layover_min: oneOf(first(params.minlay), MIN_LAYOVER_OPTIONS),
    min_self_transfer_min: oneOf(first(params.minself), MIN_SELF_TRANSFER_OPTIONS),
    max_price: Number.isFinite(price) && price > 0 && price <= 100_000 ? price : null,
    max_total_price: Number.isFinite(total) && total > 0 && total <= 1_000_000 ? total : null,
  };
}

/** Фільтри → параметри URL (лише задані). */
export function filterParams(filters: OfferFilters | undefined): [string, string][] {
  const entries: [string, string][] = [];
  if (!filters) return entries;
  if (filters.max_stops != null) entries.push(["stops", String(filters.max_stops)]);
  if (filters.airlines?.length) entries.push(["al", filters.airlines.join(",")]);
  if (filters.excluded_airlines?.length) entries.push(["xal", filters.excluded_airlines.join(",")]);
  const times: [string, string, DeparturePeriod[] | undefined, HourRange | null | undefined][] = [
    ["dep", "deph", filters.departure_periods, filters.departure_hours],
    ["arr", "arrh", filters.arrival_periods, filters.arrival_hours],
    ["rdep", "rdeph", filters.return_departure_periods, filters.return_departure_hours],
    ["rarr", "rarrh", filters.return_arrival_periods, filters.return_arrival_hours],
  ];
  for (const [periodKey, hoursKey, periods, hours] of times) {
    if (periods?.length) entries.push([periodKey, periods.join(",")]);
    if (hours) entries.push([hoursKey, `${hours.start}-${hours.end}`]);
  }
  if (filters.max_duration_hours != null)
    entries.push(["maxh", String(filters.max_duration_hours)]);
  if (filters.max_layover_hours != null)
    entries.push(["maxlay", String(filters.max_layover_hours)]);
  if (filters.min_layover_min != null) entries.push(["minlay", String(filters.min_layover_min)]);
  if (filters.min_self_transfer_min != null)
    entries.push(["minself", String(filters.min_self_transfer_min)]);
  if (filters.max_price != null) entries.push(["maxp", String(filters.max_price)]);
  if (filters.max_total_price != null) entries.push(["maxt", String(filters.max_total_price)]);
  return entries;
}

export function hasFilters(filters: OfferFilters | undefined): boolean {
  return filterParams(filters).length > 0;
}

/** URL → валідний запит пошуку, або null, якщо пошук ще не задано чи параметри биті. */
export function parseSearchParams(params: RawSearchParams): SearchState | null {
  const [origin, ...originAlso] = placeCodes(params.from);
  const [destination, ...destinationAlso] = placeCodes(params.to);
  const departure = first(params.depart);
  const returnDate = first(params.return);

  if (!origin || !destination) return null;
  const overlap = [origin, ...originAlso].some((c) =>
    [destination, ...destinationAlso].includes(c),
  );
  if (overlap || !isValidDate(departure)) return null;
  // trip=ow — «в один бік» з форми без JS: повернення, навіть якщо заповнене, ігноруємо.
  const oneWay = first(params.trip) === "ow";
  const validReturn =
    !oneWay && isValidDate(returnDate) && returnDate >= departure ? returnDate : null;
  const flex = parseFlex(first(params.flex), first(params.until), departure);
  // «Увесь місяць» починає з 1-го: повернення зсуваємо так, щоб тривалість поїздки лишилась.
  const start = flex.departure_date ?? departure;
  // Ночі (модуль 2b): лише для місяця/періоду туди-назад; повернення тоді — старт + мінімум.
  const nights = !oneWay && flex.departure_until ? parseNights(params) : null;
  const tripReturn = nights
    ? addDays(start, nights.min_nights)
    : validReturn
      ? addDays(validReturn, -daysBetween(start, departure))
      : null;

  return {
    query: {
      origin,
      destination,
      origin_also: originAlso,
      destination_also: destinationAlso,
      departure_date: start,
      return_date: tripReturn,
      flex_days: flex.flex_days,
      departure_until: flex.departure_until ?? null,
      min_nights: nights?.min_nights ?? null,
      max_nights: nights?.max_nights ?? null,
      passengers: parsePassengers(params),
      cabin: CABINS.find((c) => c === first(params.cabin)) ?? "economy",
      baggage: BAGGAGE_NEEDS.find((b) => b === first(params.bag)) ?? "none",
      direct_only: first(params.direct) === "1",
      currency: parseCurrency(params),
      profile: parseProfile(first(params.profile)),
      origin_radius_km: first(params.fromNear) === "1" ? NEARBY_RADIUS_KM : 0,
      destination_radius_km: first(params.toNear) === "1" ? NEARBY_RADIUS_KM : 0,
      filters: parseFilters(params),
    },
    sort: SORT_KEYS.find((k) => k === first(params.sort)) ?? "price",
  };
}

/** «AMS, RTM → BCN»: маршрут з усіма обраними аеропортами (модуль 2). */
export function routeTitle(query: {
  origin: string;
  destination: string;
  origin_also?: string[] | null;
  destination_also?: string[] | null;
}): string {
  const side = (main: string, also?: string[] | null) => [main, ...(also ?? [])].join(", ");
  return `${side(query.origin, query.origin_also)} → ${side(query.destination, query.destination_also)}`;
}

/** Запит → рядок URL (зворотна операція до parseSearchParams). */
export function toSearchParams(state: SearchState): URLSearchParams {
  const { query } = state;
  const params = new URLSearchParams();
  for (const code of [query.origin, ...(query.origin_also ?? [])]) params.append("from", code);
  for (const code of [query.destination, ...(query.destination_also ?? [])]) {
    params.append("to", code);
  }
  params.set("depart", query.departure_date);
  if (query.return_date) params.set("return", query.return_date);
  if (query.departure_until) {
    const month = isWholeMonth(query.departure_date, query.departure_until);
    params.set("flex", month ? "month" : "range");
    if (!month) params.set("until", query.departure_until);
  } else if (query.flex_days) params.set("flex", String(query.flex_days));
  if (query.min_nights && query.max_nights) {
    params.set("nmin", String(query.min_nights));
    params.set("nmax", String(query.max_nights));
  }
  const p = query.passengers;
  if ((p?.adults ?? 1) > 1) params.set("adults", String(p?.adults));
  if (p?.children) params.set("children", String(p.children));
  if (p?.infants) params.set("lap", String(p.infants));
  if (p?.infants_in_seat) params.set("seat", String(p.infants_in_seat));
  if (query.cabin && query.cabin !== "economy") params.set("cabin", query.cabin);
  if (query.baggage && query.baggage !== "none") params.set("bag", query.baggage);
  if (query.currency && query.currency !== "EUR") params.set("cur", query.currency);
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

/**
 * Склад пасажирів з URL з тими самими правилами, що й в API, щоб ручна правка URL не давала
 * помилку: немовлят на руках — не більше дорослих, на одного дорослого — до двох немовлят,
 * разом — до 9. Зайве відкидаємо з кінця (спершу немовлят з місцем, потім дітей).
 */
export function parsePassengers(params: RawSearchParams): Passengers {
  const adults = intInRange(first(params.adults), 1, MAX_PASSENGERS, 1);
  const lap = Math.min(intInRange(first(params.lap), 0, MAX_PASSENGERS, 0), adults);
  let seat = Math.min(intInRange(first(params.seat), 0, MAX_PASSENGERS, 0), 2 * adults - lap);
  let children = intInRange(first(params.children), 0, MAX_PASSENGERS, 0);
  children = Math.min(children, MAX_PASSENGERS - adults - lap);
  seat = Math.min(seat, MAX_PASSENGERS - adults - lap - children);
  return { adults, children, infants: lap, infants_in_seat: seat };
}

export function passengerTotal(p: Passengers | undefined): number {
  return (p?.adults ?? 1) + (p?.children ?? 0) + (p?.infants ?? 0) + (p?.infants_in_seat ?? 0);
}

/**
 * Гнучкість з URL: `flex=3` — ±3 дні; `flex=month` — увесь місяць дати вильоту;
 * `flex=range&until=…` — будь-який день від дати вильоту до `until` (≤ 62 дні).
 */
function parseFlex(
  flex: string | undefined,
  until: string | undefined,
  departure: string,
): { flex_days: number; departure_date?: string; departure_until: string | null } {
  if (flex === "month") {
    const [y, m] = departure.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return {
      flex_days: 0,
      departure_date: `${departure.slice(0, 7)}-01`,
      departure_until: `${departure.slice(0, 7)}-${String(last).padStart(2, "0")}`,
    };
  }
  if (flex === "range" && isValidDate(until)) {
    const span = daysBetween(departure, until);
    if (span >= 0 && span <= MAX_PERIOD_DAYS) return { flex_days: 0, departure_until: until };
  }
  return { flex_days: intInRange(flex, 0, MAX_FLEX_DAYS, 0), departure_until: null };
}

function isWholeMonth(from: string, until: string): boolean {
  const [y, m] = from.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return from.endsWith("-01") && until === `${from.slice(0, 7)}-${String(last).padStart(2, "0")}`;
}

/** `nmin=3&nmax=5`: обидва 1–30, мінімум ≤ максимуму; інакше — без пошуку за ночами. */
function parseNights(params: RawSearchParams): { min_nights: number; max_nights: number } | null {
  const min = Number.parseInt(first(params.nmin) ?? "", 10);
  const max = Number.parseInt(first(params.nmax) ?? "", 10);
  if (!Number.isInteger(min) || !Number.isInteger(max)) return null;
  if (min < 1 || max > MAX_NIGHTS || min > max) return null;
  return { min_nights: min, max_nights: max };
}
