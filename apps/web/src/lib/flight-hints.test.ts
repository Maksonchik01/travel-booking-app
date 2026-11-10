import type { DateOption } from "@tickets/shared";
import { describe, expect, it } from "vitest";

import { cheaperDateHint } from "./flight-hints";
import { parseSearchParams } from "./search-params";
import { parseTripParams, toTripParams } from "./trip-params";

function option(departure: string, return_date: string, price: number): DateOption {
  return {
    departure,
    return_date,
    price,
    currency: "EUR",
    verified: true,
    found_at: null,
    found_on: null,
    offers: 3,
    nights_approximate: false,
  };
}

const STATE = parseSearchParams({
  from: "WAW",
  to: "LIS",
  depart: "2026-12-05",
  return: "2026-12-08",
  flex: "3",
})!;

describe("підказка дат після пошуку рейсів (етап 4)", () => {
  it("день раніше дешевший на 42 € — з посиланням на точні дати", () => {
    const hint = cheaperDateHint(
      [
        option("2026-12-05", "2026-12-08", 210),
        option("2026-12-04", "2026-12-07", 168),
        option("2026-12-06", "2026-12-09", 205),
      ],
      STATE,
    );

    expect(hint).toMatchObject({ saving: 42, shift: -1 });
    expect(hint!.href).toContain("depart=2026-12-04&return=2026-12-07");
    expect(hint!.href).not.toContain("flex=");
  });

  it("економія менша за поріг чи немає ціни на запитані дати — без підказки", () => {
    expect(
      cheaperDateHint(
        [option("2026-12-05", "2026-12-08", 210), option("2026-12-04", "2026-12-07", 205)],
        STATE,
      ),
    ).toBeNull();
    expect(cheaperDateHint([option("2026-12-04", "2026-12-07", 100)], STATE)).toBeNull();
  });
});

describe("дорога до аеропорту в URL поїздки (етап 4)", () => {
  it("road= — сума на всіх; биті значення — без неї", () => {
    const base = { from: "WAW", to: "LIS", depart: "2026-12-05", return: "2026-12-08" };
    const query = parseTripParams({ ...base, road: "35.5" })!;
    expect(query.airport_road).toBe(35.5);
    expect(toTripParams(query).get("road")).toBe("35.5");
    expect(parseTripParams({ ...base, road: "-5" })!.airport_road).toBeNull();
    expect(parseTripParams({ ...base, road: "abc" })!.airport_road).toBeNull();
  });
});
