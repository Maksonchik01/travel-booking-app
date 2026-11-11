import type { FlightQuery } from "@tickets/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchReadiness, fetchSharedTrip, searchFlights } from "./api";

const readyBody = {
  status: "ok",
  checks: {
    database: { status: "ok", latency_ms: 1, error: null },
    redis: { status: "ok", latency_ms: 1, error: null },
  },
};

function mockFetch(impl: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchReadiness", () => {
  it("повертає ok для 200", async () => {
    mockFetch(async () => Response.json(readyBody));

    expect(await fetchReadiness()).toEqual({ kind: "ok", data: readyBody });
  });

  it("повертає degraded з деталями для 503", async () => {
    const body = { ...readyBody, status: "degraded" };
    mockFetch(async () => Response.json(body, { status: 503 }));

    expect(await fetchReadiness()).toEqual({ kind: "degraded", data: body });
  });

  it("не падає, якщо API недоступний", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });

    expect(await fetchReadiness()).toEqual({ kind: "unreachable" });
  });

  it("вважає неочікуваний статус недоступністю", async () => {
    mockFetch(async () => new Response("oops", { status: 500 }));

    expect(await fetchReadiness()).toEqual({ kind: "unreachable" });
  });
});

const query: FlightQuery = {
  origin: "WAW",
  destination: "LIS",
  departure_date: "2026-11-10",
  return_date: null,
  flex_days: 0,
  passengers: { adults: 1, children: 0, infants: 0, infants_in_seat: 0 },
  cabin: "economy",
  baggage: "none",
  direct_only: false,
  weekends: false,
  currency: "EUR",
  profile: "balanced",
  origin_radius_km: 0,
  destination_radius_km: 0,
  filters: {},
};

describe("searchFlights", () => {
  it("надсилає запит і повертає дані", async () => {
    const fetchMock = vi.fn(async () => Response.json({ offers: [], providers: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchFlights(query);

    expect(result).toEqual({ ok: true, data: { offers: [], providers: [] } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/flights\/search$/);
    expect(init.method).toBe("POST");
  });

  it("відрізняє помилку API від недоступності", async () => {
    mockFetch(async () => new Response("bad", { status: 422 }));
    expect(await searchFlights(query)).toEqual({ ok: false, reason: "error" });

    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await searchFlights(query)).toEqual({ ok: false, reason: "unreachable" });
  });
});

describe("fetchSharedTrip (V3, етап 7)", () => {
  it("розрізняє «посилання немає» (404) і збій сервера (503, мережа)", async () => {
    mockFetch(async () => Response.json({ detail: "not_found" }, { status: 404 }));
    expect(await fetchSharedTrip("abcdefghijklmnop")).toEqual({ ok: false, reason: "not_found" });

    mockFetch(async () => Response.json({ detail: "unavailable" }, { status: 503 }));
    expect(await fetchSharedTrip("abcdefghijklmnop")).toEqual({ ok: false, reason: "error" });

    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await fetchSharedTrip("abcdefghijklmnop")).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });
});
