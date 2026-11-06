import { describe, expect, it } from "vitest";

import { parseTripParams, toTripParams } from "./trip-params";

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
});
