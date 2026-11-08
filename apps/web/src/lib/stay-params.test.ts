import { describe, expect, it } from "vitest";

import { parseStayParams, toStayParams } from "./stay-params";

const NO_FILTERS = {
  min_price_per_night: null,
  max_price_per_night: null,
  min_total_price: null,
  max_total_price: null,
  min_rating: null,
  free_cancellation: false,
  breakfast_included: false,
  no_prepayment: false,
  pay_at_property: false,
  kinds: [],
  amenities: [],
  min_beds: null,
  max_distance_center_km: null,
  districts: [],
  near: null,
  near_airport: null,
  radius_km: null,
};

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
    expect(state?.query.filters).toEqual(NO_FILTERS);
    expect(state?.query.profile).toBe("balanced");
    expect(toStayParams(state!).toString()).toBe("city=LIS&in=2026-12-01&out=2026-12-03");
  });
});

describe("розширені фільтри й гості житла в URL", () => {
  const base = { city: "LIS", in: "2026-12-01", out: "2026-12-04" };

  it("ціни, умови, зручності, ліжка, розташування, біля аеропорту — туди й назад", () => {
    const state = parseStayParams({
      ...base,
      minp: "50",
      maxp: "150",
      mint: "200",
      maxt: "600",
      bfast: "1",
      noprepay: "1",
      payprop: "1",
      kind: "other,hotel",
      am: "pool,balcony,teleport",
      beds: "3",
      dist: "2",
      district: "Центр,Набережна",
      nearap: "lis",
      radius: "5",
    })!;
    expect(state.query.filters).toEqual({
      ...NO_FILTERS,
      min_price_per_night: 50,
      max_price_per_night: 150,
      min_total_price: 200,
      max_total_price: 600,
      breakfast_included: true,
      no_prepayment: true,
      pay_at_property: true,
      kinds: ["hotel", "other"],
      amenities: ["pool", "balcony"],
      min_beds: 3,
      max_distance_center_km: 2,
      districts: ["Центр", "Набережна"],
      near_airport: "LIS",
      radius_km: 5,
    });
    expect(parseStayParams(Object.fromEntries(toStayParams(state)))).toEqual(state);
  });

  it("кімнати й вік дітей; вік лише якщо для кожної дитини", () => {
    const state = parseStayParams({
      ...base,
      adults: "2",
      children: "2",
      ages: ["1", "9"],
      rooms: "2",
    })!;
    expect(state.query.guests).toEqual({ adults: 2, children: 2, children_ages: [1, 9], rooms: 2 });
    expect(toStayParams(state).get("ages")).toBe("1,9");
    const partial = parseStayParams({ ...base, children: "2", ages: "5" });
    expect(partial?.query.guests?.children_ages).toEqual([]);
    expect(parseStayParams({ ...base, adults: "1", rooms: "5" })?.query.guests?.rooms).toBe(1);
  });
});
