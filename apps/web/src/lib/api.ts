import type {
  AIStatus,
  AlertView,
  ChannelStatus,
  CalendarResult,
  ChatBody,
  ChatReply,
  ExplainResult,
  FlightQuery,
  FlightSearchResult,
  Place,
  ReadinessResponse,
  StayAnalysisResult,
  StayQuery,
  StaySearchResult,
  TripQuery,
  TripSearchResult,
} from "@tickets/shared";

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
export type ApiResult<T> = { ok: true; data: T } | { ok: false; reason: "unreachable" | "error" };

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
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, reason: "error" };
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

export function fetchCalendar(
  origin: string,
  destination: string,
  month: string,
  currency: string,
): Promise<ApiResult<CalendarResult>> {
  const params = new URLSearchParams({ origin, destination, month, currency });
  return request(`/flights/calendar?${params}`);
}

/** `kind=city` — лише міста (житло), інакше міста й аеропорти (перельоти). */
export function fetchPlaces(
  q: string,
  limit = 8,
  kind: "any" | "city" = "any",
): Promise<ApiResult<Place[]>> {
  const params = new URLSearchParams({ q, limit: String(limit), lang: "uk", kind });
  return request(`/places?${params}`);
}

/** Вимкнений чи недоступний ШІ — просто без ШІ-функцій, пошук формою працює. */
export async function fetchAIStatus(): Promise<AIStatus> {
  const result = await request<AIStatus>("/ai/status");
  return result.ok ? result.data : { enabled: false, provider: "off" };
}

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

export function explainSearch(query: FlightQuery): Promise<ApiResult<ExplainResult>> {
  return request(
    "/ai/explain",
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
): Promise<ApiResult<StayAnalysisResult>> {
  return request(
    "/ai/stays/analysis",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, stay_keys: stayKeys }),
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

export async function fetchAlertChannels(): Promise<ChannelStatus | null> {
  const result = await request<ChannelStatus>("/alerts/channels");
  return result.ok ? result.data : null;
}

export function fetchAlert(token: string): Promise<ApiResult<AlertView>> {
  return request(`/alerts/manage?${new URLSearchParams({ token })}`);
}

/** Підтвердити (email) чи вимкнути підписку за токеном з посилання. */
export function changeAlert(
  action: "confirm" | "stop",
  token: string,
): Promise<ApiResult<AlertView>> {
  return request(`/alerts/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}
