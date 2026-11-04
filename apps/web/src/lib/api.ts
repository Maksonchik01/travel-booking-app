import type {
  CalendarResult,
  FlightQuery,
  FlightSearchResult,
  Place,
  ReadinessResponse,
} from "@tickets/shared";

const API_URL = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const TIMEOUT_MS = 15_000;

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

async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`${API_URL}${path}`, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: "error" };
    return { ok: true, data: (await response.json()) as T };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

export function searchFlights(query: FlightQuery): Promise<ApiResult<FlightSearchResult>> {
  return request("/flights/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(query),
  });
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

export function fetchPlaces(q: string, limit = 8): Promise<ApiResult<Place[]>> {
  const params = new URLSearchParams({ q, limit: String(limit), lang: "uk" });
  return request(`/places?${params}`);
}
