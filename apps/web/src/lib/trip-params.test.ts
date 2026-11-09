import type { FlightQuery, Offer } from "@tickets/shared";
import { describe, expect, it } from "vitest";

import {
  parseTripDraft,
  parseTripParams,
  tripFromFlight,
  toTripParams,
  withChoice,
} from "./trip-params";

describe("trip params", () => {
  it("URL → запит і назад", () => {
    const query = parseTripParams({
      from: "waw",
      to: "lis",
      depart: "2026-12-05",
      return: "2026-12-08",
      adults: "3",
      children: "1",
      prio: "comfort",
      budget: "900",
      direct: "1",
    });

    expect(query).toMatchObject({
      origin: "WAW",
      destination: "LIS",
      adults: 3,
      children: 1,
      profile: "comfort",
      budget_total: 900,
      direct_only: true,
    });
    expect(toTripParams(query!).toString()).toBe(
      "from=WAW&to=LIS&depart=2026-12-05&return=2026-12-08&adults=3&children=1&direct=1&prio=comfort&budget=900",
    );
  });

  it("без повернення чи з битими датами — без пошуку", () => {
    expect(parseTripParams({ from: "WAW", to: "LIS", depart: "2026-12-05" })).toBeNull();
    expect(
      parseTripParams({ from: "WAW", to: "LIS", depart: "2026-12-05", return: "2026-12-05" }),
    ).toBeNull();
    expect(
      parseTripParams({ from: "WAW", to: "WAW", depart: "2026-12-05", return: "2026-12-08" }),
    ).toBeNull();
    const query = parseTripParams({
      from: "WAW",
      to: "LIS",
      depart: "2026-12-05",
      return: "2026-12-08",
      budget: "-5",
      prio: "luxury",
    });
    expect(query).toMatchObject({ budget_total: null, profile: "balanced", adults: 2 });
  });

  it("обране житло (stay) — лише валідний ключ; без міста вильоту — чернетка для форми", () => {
    const base = { from: "WAW", to: "LIS", depart: "2026-12-05", return: "2026-12-08" };
    const query = parseTripParams({ ...base, stay: "mock:mock-lis-3" });
    expect(query?.stay).toBe("mock:mock-lis-3");
    expect(toTripParams(query!).get("stay")).toBe("mock:mock-lis-3");
    expect(parseTripParams({ ...base, stay: "javascript:alert(1)" })?.stay).toBeNull();

    const draft = parseTripDraft({ to: "lis", depart: "2026-12-05", stay: "mock:mock-lis-3" });
    expect(draft).toMatchObject({
      destination: "LIS",
      departure_date: "2026-12-05",
      return_date: undefined,
      stay: "mock:mock-lis-3",
    });
    expect(parseTripDraft({ adults: "2" })).toBeNull();
  });

  it("гнучкий період, тривалість, побажання й власні витрати — туди й назад", () => {
    const query = parseTripParams({
      from: "WAW",
      to: "LIS",
      depart: "2026-12-01",
      return: "2026-12-05",
      until: "2026-12-20",
      nmin: "3",
      nmax: "5",
      bag: "checked",
      cabin: "business",
      rating: "8",
      cancel: "1",
      bfast: "1",
      dist: "3",
      xl: ["Музей", "", "Страховка"],
      xa: ["30", "10", "abc"],
    });

    expect(query).toMatchObject({
      return_date: null, // тривалість замінює повернення
      departure_until: "2026-12-20",
      min_nights: 3,
      max_nights: 5,
      baggage: "checked",
      cabin: "business",
      stay_filters: {
        min_rating: 8,
        free_cancellation: true,
        breakfast_included: true,
        max_distance_center_km: 3,
      },
      extras: [{ label: "Музей", amount: 30 }],
    });
    expect(parseTripParams(Object.fromEntries(toTripParams(query!)))).toEqual(query);
    expect(toTripParams(query!).getAll("xl")).toEqual(["Музей"]);

    // Без повернення й без тривалості — пошуку немає; кривий рейтинг — ігноруємо.
    expect(parseTripParams({ from: "WAW", to: "LIS", depart: "2026-12-01" })).toBeNull();
    expect(
      parseTripParams({ from: "WAW", to: "LIS", depart: "2026-12-01", nmin: "5", nmax: "3" }),
    ).toBeNull();
    expect(
      parseTripParams({
        from: "WAW",
        to: "LIS",
        depart: "2026-12-01",
        return: "2026-12-04",
        rating: "6",
      })?.stay_filters?.min_rating,
    ).toBeNull();
  });

  it("вибір рейсу й житла та сусідні аеропорти — у URL; withChoice міняє лише вибір", () => {
    const base = { from: "WAW", to: "LIS", depart: "2026-12-05", return: "2026-12-08" };
    const query = parseTripParams({
      ...base,
      flight: "mock:ab12cd",
      stay: "mock:mock-lis-1",
      near: "1",
    })!;
    expect(query).toMatchObject({ flight: "mock:ab12cd", stay: "mock:mock-lis-1", nearby: true });
    expect(parseTripParams({ ...base, flight: "<script>" })?.flight).toBeNull();

    const swapped = new URLSearchParams(
      withChoice(query, { stay: "mock:mock-lis-2" }).split("?")[1],
    );
    expect(Object.fromEntries(swapped)).toMatchObject({
      flight: "mock:ab12cd",
      stay: "mock:mock-lis-2",
      near: "1",
    });
    const reset = new URLSearchParams(
      withChoice(query, { flight: null, stay: null }).split("?")[1],
    );
    expect(reset.has("flight")).toBe(false);
  });

  it("«Додати до поїздки» з рейсу: фактичні дати, умови пошуку й закріплений рейс", () => {
    const leg = (at: string) => ({ departure_at: at }) as Offer["outbound"];
    const offer = {
      source: "mock",
      id: "f1",
      outbound: leg("2026-12-04T23:40:00+01:00"),
      inbound: leg("2026-12-09T07:10:00+00:00"),
    } as Offer;
    const search = {
      origin: "WAW",
      destination: "LIS",
      departure_date: "2026-12-03",
      flex_days: 3,
      passengers: { adults: 1, children: 1, infants: 0, infants_in_seat: 0 },
      baggage: "checked",
      cabin: "economy",
      direct_only: true,
      origin_radius_km: 150,
      destination_radius_km: 0,
    } as FlightQuery;

    const href = tripFromFlight(offer, search)!;
    const query = parseTripParams(Object.fromEntries(new URLSearchParams(href.split("?")[1])));
    expect(query).toMatchObject({
      origin: "WAW",
      destination: "LIS",
      departure_date: "2026-12-04",
      return_date: "2026-12-09",
      adults: 1,
      children: 1,
      baggage: "checked",
      direct_only: true,
      nearby: true,
      flight: "mock:f1",
    });
    // В один бік чи з немовлям поїздку не складемо — кнопки немає.
    expect(tripFromFlight({ ...offer, inbound: null }, search)).toBeNull();
    expect(
      tripFromFlight(offer, { ...search, passengers: { ...search.passengers!, infants: 1 } }),
    ).toBeNull();
  });

  it("публічне посилання на поїздку — лише умови пошуку, без приватного (модуль 16)", () => {
    const params = toTripParams({
      ...parseTripParams({ from: "WAW", to: "LIS", depart: "2026-12-05", return: "2026-12-08" })!,
      preferences: { flights: { airlines: ["LO"], departure_periods: [] } },
      flight: "mock:f1",
    });
    const keys = [...params.keys()];
    expect(keys).not.toContain("saved");
    expect(keys).not.toContain("preferences");
    expect(params.toString()).not.toContain("LO");
    expect(params.get("flight")).toBe("mock:f1");
  });
});
