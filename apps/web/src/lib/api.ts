import type {
  EventIn,
  SharedTrip,
  AIStatus,
  AlertEdit,
  AlertEventOut,
  AlertView,
  ChannelStatus,
  CalendarResult,
  ClickIn,
  ChatBody,
  ChatReply,
  ExplainResult,
  ExploreQuery,
  ExploreResult,
  FlightQuery,
  GeocodeResult,
  PriceSeries,
  FlightSearchResult,
  Place,
  PriceMatrix,
  SellersRequest,
  SellersResult,
  ReadinessResponse,
  StayAnalysisResult,
  StayQuery,
  StayDetailRequest,
  StayDetailResult,
  StayRatesRequest,
  StayRatesResult,
  StaySearchResult,
  CheaperResult,
  TripQuery,
  TripRefresh,
  TripRefreshRequest,
  TripSearchResult,
} from "@tickets/shared";

import { cache } from "react";

import { clientIpHeaders } from "@/lib/client-ip";

const API_URL = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const TIMEOUT_MS = 15_000;
/** Живий пошук: провайдер має до 30 с (SERPAPI_TIMEOUT_S). */
const SEARCH_TIMEOUT_MS = 35_000;
/** Пояснення: пошук з кешу + до двох викликів потужнішої моделі. */
const EXPLAIN_TIMEOUT_MS = 45_000;
/** Репліка агента: кілька викликів моделі + до двох живих пошуків. */
const CHAT_TIMEOUT_MS = 90_000;

export type ApiStatus =
  { kind: "ok" | "degraded"; data: ReadinessResponse } | { kind: "unreachable" };

/** Результат виклику API: або дані, або причина, чому їх немає (без винятків назовні). */
export type ApiResult<T> =
  { ok: true; data: T } | { ok: false; reason: "unreachable" | "error" | "rate_limited" };

export async function fetchReadiness(signal?: AbortSignal): Promise<ApiStatus> {
  try {
    const response = await fetch(`${API_URL}/health/ready`, { cache: "no-store", signal });
    // 503 теж повертає типізоване тіло з деталями перевірок.
    if (response.status !== 200 && response.status !== 503) {
      return { kind: "unreachable" };
    }
    const data = (await response.json()) as ReadinessResponse;
    return { kind: data.status, data };
  } catch {
    return { kind: "unreachable" };
  }
}

async function request<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = TIMEOUT_MS,
): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { ...init?.headers, ...(await clientIpHeaders()) },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 429) return { ok: false, reason: "rate_limited" };
    if (!response.ok) return { ok: false, reason: "error" };
    if (response.status === 204) return { ok: true, data: null as T };
    return { ok: true, data: (await response.json()) as T };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

export function searchFlights(query: FlightQuery): Promise<ApiResult<FlightSearchResult>> {
  return request(
    "/flights/search",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(query),
    },
    SEARCH_TIMEOUT_MS,
  );
}

/** Explore (ADR 0045): кешовані ціни «звідси будь-куди»; режим trip — ще й житло для топ-3. */
export function searchExplore(query: ExploreQuery): Promise<ApiResult<ExploreResult>> {
  return request<ExploreResult>(
    "/explore",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query),
    },
    SEARCH_TIMEOUT_MS,
  );
}

export function fetchCalendar(
  origin: string,
  destination: string,
  month: string,
  currency: string,
): Promise<ApiResult<CalendarResult>> {
  const params = new URLSearchParams({ origin, destination, month, currency });
  return request(`/flights/calendar?${params}`);
}

/** Продавці рейсу й свіжа ціна (1 запит квоти SerpApi, кеш 30 хв) — на вимогу з картки. */
export function fetchSellers(body: SellersRequest): Promise<ApiResult<SellersResult>> {
  return request(
    "/flights/sellers",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    SEARCH_TIMEOUT_MS,
  );
}

/** «Знайти дешевший варіант» поїздки (модуль 8b): ще один пошук перельотів — лише на вимогу. */
export function fetchCheaperTrip(query: TripQuery): Promise<ApiResult<CheaperResult>> {
  return request(
    "/trips/cheaper",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(query),
    },
    SEARCH_TIMEOUT_MS,
  );
}

/** «Оновити ціни» збереженої поїздки (модуль 8c) — та сама конфігурація заново. */
export function fetchTripRefresh(body: TripRefreshRequest): Promise<ApiResult<TripRefresh>> {
  return request(
    "/trips/refresh",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    SEARCH_TIMEOUT_MS,
  );
}

/** Тарифи продавців житла на ті самі дати й гостей (модуль 7) — на вимогу з картки. */
export function fetchStayRates(body: StayRatesRequest): Promise<ApiResult<StayRatesResult>> {
  return request(
    "/stays/rates",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    SEARCH_TIMEOUT_MS,
  );
}

/** Сторінка об'єкта (ADR 0044): об'єкт з тієї самої видачі — платне джерело відповідає з кешу. */
export function fetchStayDetail(body: StayDetailRequest): Promise<ApiResult<StayDetailResult>> {
  return request(
    "/stays/detail",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    SEARCH_TIMEOUT_MS,
  );
}

/** Матриця туди-назад (виліт × повернення) з кешованих цін — без живих запитів. */
export function fetchMatrix(
  origin: string,
  destination: string,
  departures: [string, string],
  returns: [string, string],
  currency: string,
): Promise<ApiResult<PriceMatrix>> {
  const params = new URLSearchParams({
    origin,
    destination,
    depart_from: departures[0],
    depart_to: departures[1],
    return_from: returns[0],
    return_to: returns[1],
    currency,
  });
  return request(`/flights/matrix?${params}`);
}

/** `kind=city` — лише міста (житло), інакше міста й аеропорти (перельоти). */
export function fetchPlaces(
  q: string,
  limit = 8,
  kind: "any" | "city" = "any",
  lang: "uk" | "en" = "uk",
): Promise<ApiResult<Place[]>> {
  const params = new URLSearchParams({ q, limit: String(limit), lang, kind });
  return request(`/places?${params}`);
}

/** Історія цін на ці дати (етап 6): найнижча ціна на кожен день спостереження. */
export function fetchFlightHistory(params: {
  origin: string;
  destination: string;
  departure: string;
  return?: string | null;
  adults: number;
  cabin: string;
  currency: string;
}): Promise<ApiResult<PriceSeries>> {
  const query = new URLSearchParams({
    origin: params.origin,
    destination: params.destination,
    departure: params.departure,
    adults: String(params.adults),
    cabin: params.cabin,
    currency: params.currency,
  });
  if (params.return) query.set("return", params.return);
  return request(`/flights/history?${query}`);
}

export function fetchStayHistory(params: {
  source: string;
  stayId: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  currency: string;
}): Promise<ApiResult<PriceSeries>> {
  const query = new URLSearchParams({
    source: params.source,
    stay_id: params.stayId,
    in: params.checkIn,
    out: params.checkOut,
    guests: String(params.guests),
    currency: params.currency,
  });
  return request(`/stays/history?${query}`);
}

/** Місце біля житла (етап 5): адреса чи визначна точка в місті — OpenStreetMap через API. */
export function fetchGeocode(
  q: string,
  city: string,
  lang: "uk" | "en" = "uk",
): Promise<ApiResult<GeocodeResult>> {
  const params = new URLSearchParams({ q, city, lang });
  return request(`/places/geocode?${params}`);
}

/** Вимкнений чи недоступний ШІ — просто без ШІ-функцій, пошук формою працює. */
export const fetchAIStatus = cache(async (): Promise<AIStatus> => {
  // Один запит на рендер: форма, чат і пояснення на одній сторінці питають те саме
  // (fetch із signal Next не об'єднує сам, модуль 17.5).
  const result = await request<AIStatus>("/ai/status");
  return result.ok ? result.data : { enabled: false, provider: "off" };
});

export function chatWithAssistant(body: ChatBody): Promise<ApiResult<ChatReply>> {
  return request(
    "/ai/chat",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    CHAT_TIMEOUT_MS,
  );
}

export function explainSearch(
  query: FlightQuery,
  locale: string,
): Promise<ApiResult<ExplainResult>> {
  return request(
    `/ai/explain?${new URLSearchParams({ locale })}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(query),
    },
    EXPLAIN_TIMEOUT_MS,
  );
}

export function searchStays(query: StayQuery): Promise<ApiResult<StaySearchResult>> {
  return request(
    "/stays/search",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(query),
    },
    SEARCH_TIMEOUT_MS,
  );
}

export function analyzeStays(
  query: StayQuery,
  stayKeys: string[],
  locale: string,
): Promise<ApiResult<StayAnalysisResult>> {
  return request(
    "/ai/stays/analysis",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, stay_keys: stayKeys, locale }),
    },
    EXPLAIN_TIMEOUT_MS,
  );
}

/** Поїздка: перельоти туди-назад (живий пошук) + житло на дати рейсів. */
export function searchTrip(query: TripQuery): Promise<ApiResult<TripSearchResult>> {
  return request(
    "/trips/search",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(query),
    },
    SEARCH_TIMEOUT_MS,
  );
}

export const fetchAlertChannels = cache(async (): Promise<ChannelStatus | null> => {
  const result = await request<ChannelStatus>("/alerts/channels");
  return result.ok ? result.data : null;
});

export function fetchAlert(token: string): Promise<ApiResult<AlertView>> {
  return request(`/alerts/manage?${new URLSearchParams({ token })}`);
}

export type AlertAction = "confirm" | "stop" | "pause" | "resume" | "delete";

/** Дія над підпискою за токеном з посилання (11.3): підтвердити, вимкнути, призупинити,
 * відновити, видалити. */
export function changeAlert(action: AlertAction, token: string): Promise<ApiResult<unknown>> {
  return request(`/alerts/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

export function editAlert(token: string, edit: AlertEdit): Promise<ApiResult<AlertView>> {
  return request("/alerts/edit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, edit }),
  });
}

/** Історія спрацювань і змін; помилка — порожньо (сторінка працює й без неї). */
export async function fetchAlertHistory(token: string): Promise<AlertEventOut[]> {
  const result = await request<AlertEventOut[]>(
    `/alerts/history?${new URLSearchParams({ token })}`,
  );
  return result.ok ? result.data : [];
}

/** Облік переходу на партнера. Без відповіді й винятків: редирект від нього не залежить. */
export async function logOutboundClick(click: ClickIn): Promise<void> {
  try {
    await fetch(`${API_URL}/outbound/clicks`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await clientIpHeaders()) },
      body: JSON.stringify(click),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Клік не порахується — це не причина не пустити людину до партнера.
  }
}

/** Ключ повідомлення про помилку пошуку (`unreachable` / `error` / `rateLimited` у розділі сторінки). */
export const ERROR_KEY = {
  unreachable: "unreachable",
  error: "error",
  rate_limited: "rateLimited",
} as const;

export async function fetchCountryCodes(): Promise<string[]> {
  const result = await request<string[]>("/places/countries");
  return result.ok ? result.data : [];
}

/** Анонімна подія використання (модуль 19). Збій — тихо: аналітика нічого не ламає. */
export async function recordEvent(event: EventIn): Promise<void> {
  await request("/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
}

/** Публічна поїздка за посиланням власника (модуль 20.2); 404 — вимкнено чи не існує. */
export function fetchSharedTrip(token: string): Promise<ApiResult<SharedTrip>> {
  return request(`/shared/trips/${encodeURIComponent(token)}`);
}
