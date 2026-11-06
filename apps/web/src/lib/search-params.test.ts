import { describe, expect, it } from "vitest";

import {
  NEARBY_RADIUS_KM,
  parseSearchParams,
  toSearchParams,
  withDepartureDate,
} from "./search-params";

const base = { from: "waw", to: "lis", depart: "2026-11-10" };

describe("parseSearchParams", () => {
  it("повертає null, поки пошук не задано", () => {
    expect(parseSearchParams({})).toBeNull();
  });

  it("нормалізує коди та застосовує значення за замовчуванням", () => {
    expect(parseSearchParams(base)).toEqual({
      query: {
        origin: "WAW",
        destination: "LIS",
        departure_date: "2026-11-10",
        return_date: null,
        flex_days: 0,
        passengers: { adults: 1, children: 0, infants: 0 },
        direct_only: false,
        currency: "EUR",
        profile: "balanced",
        origin_radius_km: 0,
        destination_radius_km: 0,
        filters: {
          max_stops: null,
          airlines: [],
          departure_periods: [],
          max_duration_hours: null,
          max_price: null,
        },
      },
      sort: "price",
    });
  });

  it.each([
    [{ ...base, from: "WA" }],
    [{ ...base, to: "WAW" }],
    [{ ...base, depart: "10.11.2026" }],
    [{ ...base, depart: "2026-13-45" }],
  ])("відкидає биті параметри %#", (params) => {
    expect(parseSearchParams(params)).toBeNull();
  });

  it("биті фільтри відкидає, а не ламає пошук", () => {
    const state = parseSearchParams({
      ...base,
      stops: "7",
      al: "RYANAIR,fr",
      dep: "brunch",
      maxh: "0",
      sort: "x",
    });

    expect(state?.query.filters).toEqual({
      max_stops: null,
      airlines: ["FR"],
      departure_periods: [],
      max_duration_hours: null,
      max_price: null,
    });
    expect(state?.sort).toBe("price");
  });

  it("невідомий профіль — balanced", () => {
    expect(parseSearchParams({ ...base, profile: "yolo" })?.query.profile).toBe("balanced");
  });

  it("обмежує числа та ігнорує повернення раніше вильоту", () => {
    const state = parseSearchParams({ ...base, flex: "99", adults: "0", return: "2026-11-01" });

    expect(state?.query.flex_days).toBe(7);
    expect(state?.query.passengers?.adults).toBe(1);
    expect(state?.query.return_date).toBeNull();
  });

  it("round-trip через URL зберігає стан", () => {
    const state = parseSearchParams({
      ...base,
      return: "2026-11-17",
      flex: "2",
      adults: "2",
      direct: "1",
      sort: "duration",
      profile: "time_is_money",
      fromNear: "1",
      stops: "1",
      al: "fr,W6",
      dep: "evening,morning",
      maxh: "8",
      maxp: "150",
    })!;

    expect(state.query.filters).toEqual({
      max_stops: 1,
      airlines: ["FR", "W6"],
      departure_periods: ["morning", "evening"],
      max_duration_hours: 8,
      max_price: 150,
    });

    expect(state.query.origin_radius_km).toBe(NEARBY_RADIUS_KM);
    expect(state.query.destination_radius_km).toBe(0);

    const again = parseSearchParams(Object.fromEntries(toSearchParams(state)));

    expect(again).toEqual(state);
  });
});

describe("withDepartureDate", () => {
  it("зсуває повернення на ту саму тривалість поїздки", () => {
    const state = parseSearchParams({ ...base, return: "2026-11-17" })!;

    const moved = withDepartureDate(state, "2026-11-28");

    expect(moved.query.departure_date).toBe("2026-11-28");
    expect(moved.query.return_date).toBe("2026-12-05");
  });
});
