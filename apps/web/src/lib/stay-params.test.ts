import { describe, expect, it } from "vitest";

import { parseStayParams, toStayParams } from "./stay-params";

describe("stay params", () => {
  it("URL → запит і назад", () => {
    const state = parseStayParams({
      city: "lis",
      in: "2026-12-05",
      out: "2026-12-08",
      adults: "3",
      prio: "center",
      sort: "rating",
      maxp: "150",
      rating: "8",
      cancel: "1",
      kind: ["hotel", "hostel"],
    });

    expect(state?.query).toMatchObject({
      city: "LIS",
      guests: { adults: 3, children: 0 },
      profile: "center",
      filters: {
        max_price_per_night: 150,
        min_rating: 8,
        free_cancellation: true,
        kinds: ["hotel", "hostel"],
      },
    });
    expect(toStayParams(state!).toString()).toBe(
      "city=LIS&in=2026-12-05&out=2026-12-08&adults=3&prio=center&sort=rating&maxp=150&rating=8&cancel=1&kind=hotel%2Chostel",
    );
  });

  it("биті дати й параметри — без пошуку або значення за замовчуванням", () => {
    expect(parseStayParams({ city: "LIS", in: "2026-12-08", out: "2026-12-08" })).toBeNull();
    expect(parseStayParams({ city: "LIS", in: "2026-12-01", out: "2027-01-15" })).toBeNull();
    expect(parseStayParams({ city: "Lisbon", in: "2026-12-01", out: "2026-12-03" })).toBeNull();

    const state = parseStayParams({
      city: "LIS",
      in: "2026-12-01",
      out: "2026-12-03",
      rating: "6",
      prio: "luxury",
      kind: "castle",
    });
    expect(state?.query.filters).toEqual({
      max_price_per_night: null,
      min_rating: null,
      free_cancellation: false,
      kinds: [],
    });
    expect(state?.query.profile).toBe("balanced");
    expect(toStayParams(state!).toString()).toBe("city=LIS&in=2026-12-01&out=2026-12-03");
  });
});
