import type { Account } from "@tickets/shared";
import { describe, expect, it } from "vitest";

import {
  flightDefaults,
  flightPreferences,
  flightPrefFilters,
  stayPreferences,
  tripDefaults,
  tripPreferences,
  withTripDraft,
  mergeFilters,
  searchPrefsFromForm,
  stayPrefParams,
} from "@/lib/search-prefs";

function form(entries: [string, string][]): FormData {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

describe("search preferences", () => {
  it("reads the form and drops invalid values", () => {
    const prefs = searchPrefsFromForm(
      form([
        ["cabin", "business"],
        ["bag", "spaceship"],
        ["stops", "1"],
        ["airlines", "lo, lh,  LO, toolong"],
        ["profile", ""],
        ["dep", "morning"],
        ["dep", "noon"],
        ["kind", "hotel"],
        ["rating", "8"],
        ["dist", "4"],
        ["am", "wifi"],
        ["cancel", "1"],
        ["prio", "center"],
      ]),
    );
    expect(prefs.flights).toEqual({
      cabin: "business",
      baggage: null,
      max_stops: 1,
      airlines: ["LO", "LH"],
      profile: null,
      departure_periods: ["morning"],
    });
    expect(prefs.stays).toEqual({
      kinds: ["hotel"],
      min_rating: 8,
      max_distance_km: null,
      amenities: ["wifi"],
      free_cancellation: true,
      profile: "center",
    });
  });

  it("turns preferences into URL filters; saved result filters win", () => {
    const prefs = searchPrefsFromForm(
      form([
        ["stops", "0"],
        ["airlines", "LO"],
        ["dep", "evening"],
        ["kind", "apartment"],
        ["cancel", "1"],
      ]),
    ) as Account["search_prefs"];
    const flight = flightPrefFilters(prefs);
    expect(flight).toEqual([
      ["stops", "0"],
      ["al", "LO"],
      ["dep", "evening"],
    ]);
    expect(mergeFilters("stops=1&maxp=200", flight)).toBe("stops=1&maxp=200&al=LO&dep=evening");
    expect(mergeFilters(null, [])).toBeNull();
    expect(stayPrefParams(prefs)).toEqual([
      ["kind", "apartment"],
      ["cancel", "1"],
    ]);
  });

  it("uses home airport and profile currency for a new flight search", () => {
    const account = {
      home_airport: "WAW",
      currency: "PLN",
      search_prefs: { flights: { cabin: "business", profile: "budget" }, stays: {} },
    } as unknown as Account;
    expect(flightDefaults(account)).toEqual({
      origin: "WAW",
      cabin: "business",
      baggage: undefined,
      currency: "PLN",
      profile: "budget",
    });
  });

  it("passes airlines and departure time as soft scoring preferences", () => {
    expect(flightPreferences(null)).toBeUndefined();
    expect(
      flightPreferences({
        flights: { airlines: [], departure_periods: [], max_stops: 0 },
        stays: {},
      } as never),
    ).toBeUndefined();
    expect(
      flightPreferences({
        flights: { airlines: ["LO"], departure_periods: ["morning"] },
        stays: {},
      } as never),
    ).toEqual({ airlines: ["LO"], departure_periods: ["morning"] });
  });

  it("passes preferred amenities to stays and both parts to trips", () => {
    const prefs = {
      flights: { airlines: ["LO"], departure_periods: [] },
      stays: { amenities: ["wifi"] },
    } as never;
    expect(stayPreferences(prefs)).toEqual({ amenities: ["wifi"] });
    expect(tripPreferences(prefs)).toEqual({
      flights: { airlines: ["LO"], departure_periods: [] },
      stays: { amenities: ["wifi"] },
    });
    expect(tripPreferences(null)).toBeUndefined();
  });

  it("fills a new trip from the cabinet; a carried draft wins", () => {
    const account = {
      home_airport: "WAW",
      search_prefs: {
        flights: { cabin: "business", baggage: "checked", max_stops: 0, profile: "time_is_money" },
        stays: { min_rating: 8, max_distance_km: 2, free_cancellation: true, kinds: ["hotel"] },
      },
    } as unknown as Account;
    const defaults = tripDefaults(account);
    expect(defaults).toEqual({
      origin: "WAW",
      cabin: "business",
      baggage: "checked",
      direct_only: true,
      profile: "comfort",
      stay_filters: { min_rating: 8, max_distance_center_km: 2, free_cancellation: true },
    });
    expect(
      withTripDraft(defaults, { origin: undefined, destination: "LIS", adults: 3 }),
    ).toMatchObject({ origin: "WAW", destination: "LIS", adults: 3, cabin: "business" });
    expect(withTripDraft(null, { destination: "LIS" })).toEqual({ destination: "LIS" });
  });
});
