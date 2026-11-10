import type {
  ExploreCategory,
  ExploreDestination,
  ExploreMode,
  ExploreQuery,
  ExploreRegion,
} from "@tickets/shared";

import { CURRENCIES, type RawSearchParams } from "@/lib/search-params";

/**
 * Explore (ADR 0045): стан пошуку напрямків — у URL.
 * `/explore?from=AMS&from=RTM&to=europe|ES&depart=&until=|return=&nmin=&nmax=&wk=1&adults=&budget=
 * &mode=trip&cat=sea&cat=city&direct=1&cur=&view=map`. `to` — регіон (слово) або країна (ISO2),
 * без нього — будь-куди. Точні дати — `return`, гнучкі — `until` (+ ночі).
 */
export const EXPLORE_PATH = "/explore";
export const MAX_ORIGINS = 3;
export const MAX_SPAN_DAYS = 92;
export const MAX_EXPLORE_NIGHTS = 30;
export const EXPLORE_LIMIT = 30;
export const REGIONS: readonly ExploreRegion[] = [
  "europe",
  "middle_east",
  "africa",
  "asia",
  "north_america",
  "south_america",
  "oceania",
];
export const CATEGORIES: readonly ExploreCategory[] = [
  "city",
  "sea",
  "mountains",
  "romance",
  "culture",
  "nightlife",
];
/** Тривалість (ночі): короткі вихідні, 3–4 дні, тиждень, довше. */
export const NIGHT_PRESETS = [
  [1, 3],
  [2, 4],
  [4, 7],
  [7, 14],
] as const;
export const DEFAULT_NIGHTS = NIGHT_PRESETS[1];

const IATA = /^[A-Z]{3}$/;
const COUNTRY = /^[A-Z]{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type ExploreView = "list" | "map";

function all(value: string | string[] | undefined): string[] {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.flatMap((item) => item.split(",")).map((item) => item.trim());
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value || undefined;
}

function day(value: string | undefined): string | undefined {
  if (!value || !DAY.test(value)) return undefined;
  return Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? undefined : value;
}

function int(value: string | undefined, min: number, max: number): number | undefined {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function shiftDay(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function origins(raw: RawSearchParams): string[] {
  const codes = all(raw.from)
    .map((code) => code.toUpperCase())
    .filter((code) => IATA.test(code));
  return [...new Set(codes)].slice(0, MAX_ORIGINS);
}

/** Що задано в «куди»: регіон, країна чи нічого (будь-куди). */
export function parseScope(value: string | undefined): {
  region?: ExploreRegion;
  country?: string;
} {
  if (!value) return {};
  if ((REGIONS as readonly string[]).includes(value)) return { region: value as ExploreRegion };
  const upper = value.toUpperCase();
  return COUNTRY.test(upper) ? { country: upper } : {};
}

/** Повний запит з URL; неповний чи невалідний — null (сторінка показує лише форму). */
export function parseExploreParams(raw: RawSearchParams): ExploreQuery | null {
  const from = origins(raw);
  const depart = day(first(raw.depart));
  if (!from.length || !depart) return null;
  const until = day(first(raw.until));
  const back = day(first(raw.return));
  let nmin = int(first(raw.nmin), 1, MAX_EXPLORE_NIGHTS);
  let nmax = int(first(raw.nmax), 1, MAX_EXPLORE_NIGHTS);
  const query: ExploreQuery = {
    origins: from,
    departure_date: depart,
    ...parseScope(first(raw.to)),
    adults: int(first(raw.adults), 1, 9) ?? 1,
    mode: first(raw.mode) === "trip" ? "trip" : "flights",
    direct_only: first(raw.direct) === "1",
    weekends: first(raw.wk) === "1",
    currency: CURRENCIES.find((c) => c === first(raw.cur)?.toUpperCase()) ?? "EUR",
    lang: "uk",
    limit: EXPLORE_LIMIT,
  };
  const categories = all(raw.cat).filter((c): c is ExploreCategory =>
    (CATEGORIES as readonly string[]).includes(c),
  );
  if (categories.length) query.categories = [...new Set(categories)];
  const budget = int(first(raw.budget), 1, 1_000_000);
  if (budget) query.budget = budget;

  if (until) {
    const span = daysBetween(depart, until);
    if (span < 0 || span > MAX_SPAN_DAYS) return null;
    query.departure_until = until;
    if (nmin === undefined || nmax === undefined) [nmin, nmax] = DEFAULT_NIGHTS;
    if (nmin > nmax) return null;
    query.min_nights = nmin;
    query.max_nights = nmax;
  } else {
    if (!back) return null;
    const nights = daysBetween(depart, back);
    if (nights < 1 || nights > MAX_EXPLORE_NIGHTS) return null;
    query.return_date = back;
  }
  return query;
}

/** Неповний пошук (чернетка, категорія з головної) — для початкових значень форми. */
export function parseExploreDraft(raw: RawSearchParams): Partial<ExploreQuery> {
  const draft: Partial<ExploreQuery> = { ...parseScope(first(raw.to)) };
  const from = origins(raw);
  if (from.length) draft.origins = from;
  const depart = day(first(raw.depart));
  if (depart) draft.departure_date = depart;
  const back = day(first(raw.return));
  const until = day(first(raw.until));
  if (back) draft.return_date = back;
  else if (until) draft.departure_until = until;
  const categories = all(raw.cat).filter((c): c is ExploreCategory =>
    (CATEGORIES as readonly string[]).includes(c),
  );
  if (categories.length) draft.categories = categories;
  const adults = int(first(raw.adults), 1, 9);
  if (adults) draft.adults = adults;
  const budget = int(first(raw.budget), 1, 1_000_000);
  if (budget) draft.budget = budget;
  if (first(raw.mode) === "trip") draft.mode = "trip";
  return draft;
}

/** Explore зі спільного режимів пошуку (звідки, дати, люди). */
export function exploreFromCommon(common: {
  from?: string;
  depart?: string;
  return?: string;
  adults?: number;
}): string {
  const params = new URLSearchParams();
  if (common.from) params.set("from", common.from);
  if (common.depart) params.set("depart", common.depart);
  if (common.return) params.set("return", common.return);
  if (common.adults) params.set("adults", String(common.adults));
  return exploreFromFlights(params);
}

/** Канонічна адреса пошуку (без `view`). */
export function toExploreParams(query: ExploreQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const code of query.origins) params.append("from", code);
  const scope = query.region ?? query.country;
  if (scope) params.set("to", scope);
  params.set("depart", query.departure_date);
  if (query.departure_until) {
    params.set("until", query.departure_until);
    if (query.min_nights) params.set("nmin", String(query.min_nights));
    if (query.max_nights) params.set("nmax", String(query.max_nights));
  } else if (query.return_date) {
    params.set("return", query.return_date);
  }
  if (query.weekends) params.set("wk", "1");
  if (query.adults && query.adults > 1) params.set("adults", String(query.adults));
  if (query.budget) params.set("budget", String(query.budget));
  if (query.mode === "trip") params.set("mode", "trip");
  for (const c of query.categories ?? []) params.append("cat", c);
  if (query.direct_only) params.set("direct", "1");
  if (query.currency && query.currency !== "EUR") params.set("cur", query.currency);
  return params;
}

export function exploreHref(query: ExploreQuery, view: ExploreView = "list"): string {
  const params = toExploreParams(query);
  if (view === "map") params.set("view", "map");
  return `${EXPLORE_PATH}?${params}`;
}

/** Категорія увімкнена/вимкнена — той самий пошук (кеш джерела, нових запитів немає). */
export function toggleCategory(query: ExploreQuery, category: ExploreCategory): ExploreQuery {
  const current = query.categories ?? [];
  const next = current.includes(category)
    ? current.filter((c) => c !== category)
    : [...current, category];
  return { ...query, categories: next };
}

export function withMode(query: ExploreQuery, mode: ExploreMode): ExploreQuery {
  return { ...query, mode };
}

function legDates(destination: ExploreDestination): { depart: string; back: string | null } {
  const offer = destination.offer;
  return {
    depart: offer.outbound.departure_at.slice(0, 10),
    back: offer.inbound ? offer.inbound.departure_at.slice(0, 10) : null,
  };
}

/** Рейси за цим напрямком і датами — звичайний пошук (живі джерела перевірять ціну). */
export function flightsHref(destination: ExploreDestination, query: ExploreQuery): string {
  const { depart, back } = legDates(destination);
  const params = new URLSearchParams({
    from: destination.offer.outbound.origin,
    to: destination.code,
    depart,
  });
  if (back) params.set("return", back);
  if (query.adults && query.adults > 1) params.set("adults", String(query.adults));
  if (query.direct_only) params.set("direct", "1");
  if (query.currency && query.currency !== "EUR") params.set("cur", query.currency);
  return `/?${params}`;
}

/** Готова поїздка в Smart Trip Builder: той самий маршрут, дати, люди й бюджет. */
export function tripHref(destination: ExploreDestination, query: ExploreQuery): string {
  const { depart, back } = legDates(destination);
  const params = new URLSearchParams({
    from: destination.offer.outbound.origin,
    to: destination.code,
    depart,
  });
  if (back) params.set("return", back);
  if (query.adults && query.adults > 1) params.set("adults", String(query.adults));
  if (query.budget) params.set("budget", String(query.budget));
  if (query.direct_only) params.set("direct", "1");
  if (query.currency && query.currency !== "EUR") params.set("cur", query.currency);
  return `/trip?${params}`;
}

/** «Будь-куди» з пошуку перельотів: звідки, дати, люди, «лише прямі», валюта — як є. */
export function exploreFromFlights(source: URLSearchParams | FormData): string {
  const read = (key: string) => {
    const value = source.get(key);
    return typeof value === "string" && value ? value : undefined;
  };
  const params = new URLSearchParams();
  const from = read("from")?.toUpperCase();
  if (from && IATA.test(from)) params.set("from", from);
  const depart = day(read("depart"));
  const back = read("trip") === "ow" ? undefined : day(read("return"));
  if (depart && back && daysBetween(depart, back) >= 1) {
    params.set("depart", depart);
    params.set("return", back);
  } else if (depart) {
    params.set("depart", depart);
    params.set("until", shiftDay(depart, 30));
  }
  const adults = int(read("adults"), 1, 9);
  if (adults && adults > 1) params.set("adults", String(adults));
  if (read("direct") === "1" || read("direct") === "on") params.set("direct", "1");
  const cur = read("cur")?.toUpperCase();
  if (cur && cur !== "EUR" && (CURRENCIES as readonly string[]).includes(cur)) {
    params.set("cur", cur);
  }
  const query = params.toString();
  return query ? `${EXPLORE_PATH}?${query}` : EXPLORE_PATH;
}

export type DatePreset = "thisWeekend" | "nextWeekend" | "monthWeekends" | "short" | "week";

/**
 * Швидкі дати від `today` (YYYY-MM-DD, місцевий день): вихідні — виліт пт, повернення нд;
 * «вихідні місяця» — увесь наступний місяць лише з вихідними; короткі — наступні 30 днів.
 */
export function datePreset(
  preset: DatePreset,
  today: string,
): {
  depart: string;
  until?: string;
  back?: string;
  nights?: readonly [number, number];
  weekends?: boolean;
} {
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 — нд, 5 — пт
  const toFriday = (5 - weekday + 7) % 7;
  // Сьогодні вже сб/нд — «найближчі» вихідні наступні.
  const friday = shiftDay(today, weekday === 6 ? 6 : weekday === 0 ? 5 : toFriday);
  switch (preset) {
    case "thisWeekend":
      return { depart: friday, back: shiftDay(friday, 2) };
    case "nextWeekend":
      return { depart: shiftDay(friday, 7), back: shiftDay(friday, 9) };
    case "monthWeekends": {
      const start = new Date(`${today}T00:00:00Z`);
      const firstDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
      const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 2, 0));
      return {
        depart: firstDay.toISOString().slice(0, 10),
        until: lastDay.toISOString().slice(0, 10),
        nights: [1, 3],
        weekends: true,
      };
    }
    case "short":
      return { depart: shiftDay(today, 1), until: shiftDay(today, 31), nights: [2, 3] };
    case "week":
      return { depart: shiftDay(today, 1), until: shiftDay(today, 31), nights: [4, 6] };
  }
}

export type Relaxation =
  "budget" | "categories" | "anywhere" | "flexible" | "nights" | "weekends" | "direct";

/** Порожньо чи мало (ADR 0040): посилання з ОДНІЄЮ зміною — що послабити; самі не застосовуємо. */
export function exploreRelaxations(
  query: ExploreQuery,
): { key: Relaxation; query: ExploreQuery }[] {
  const out: { key: Relaxation; query: ExploreQuery }[] = [];
  if (query.budget) out.push({ key: "budget", query: { ...query, budget: undefined } });
  if (query.direct_only) out.push({ key: "direct", query: { ...query, direct_only: false } });
  if (query.categories?.length)
    out.push({ key: "categories", query: { ...query, categories: [] } });
  if (query.region || query.country) {
    out.push({ key: "anywhere", query: { ...query, region: undefined, country: undefined } });
  }
  if (query.weekends) out.push({ key: "weekends", query: { ...query, weekends: false } });
  if (query.return_date) {
    const nights = daysBetween(query.departure_date, query.return_date);
    out.push({
      key: "flexible",
      query: {
        ...query,
        return_date: undefined,
        departure_until: shiftDay(query.departure_date, 30),
        min_nights: Math.max(1, nights - 1),
        max_nights: Math.min(MAX_EXPLORE_NIGHTS, nights + 2),
      },
    });
  } else if ((query.min_nights ?? 1) > 1 || (query.max_nights ?? 14) < 14) {
    out.push({ key: "nights", query: { ...query, min_nights: 1, max_nights: 14 } });
  }
  return out;
}
