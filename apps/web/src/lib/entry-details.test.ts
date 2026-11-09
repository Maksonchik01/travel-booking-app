import { describe, expect, it } from "vitest";

import { entryDetails } from "@/lib/entry-details";

describe("history entry details", () => {
  it("parses a flight search with passengers, cabin and filters", () => {
    const details = entryDetails(
      "flights",
      "from=WAW&to=LIS&depart=2026-12-05&return=2026-12-12&adults=2&children=1&cabin=business&stops=0&al=LO,TP",
    );
    expect(details).toMatchObject({
      route: "WAW → LIS",
      dates: { from: "2026-12-05", to: "2026-12-12" },
      adults: 2,
      children: 1,
      cabin: "business",
    });
    expect(details?.filters).toEqual([
      ["stops", "0"],
      ["al", "LO,TP"],
    ]);
  });

  it("parses stays and trips; broken params give null", () => {
    expect(
      entryDetails("stays", "city=LIS&in=2026-12-05&out=2026-12-08&adults=2&rooms=2&rating=8"),
    ).toMatchObject({
      route: "LIS",
      rooms: 2,
      filters: [["rating", "8"]],
    });
    expect(
      entryDetails(
        "trip",
        "from=WAW&to=LIS&depart=2026-12-05&return=2026-12-08&budget=900&direct=1",
      ),
    ).toMatchObject({ route: "WAW → LIS", budget: 900, filters: [["stops", "0"]] });
    expect(entryDetails("flights", "from=WAW")).toBeNull();
  });
});
