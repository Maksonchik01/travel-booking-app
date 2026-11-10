import { describe, expect, it } from "vitest";

import {
  NEARBY_RADIUS_KM,
  parsePassengers,
  parseSearchParams,
  toSearchParams,
  withDepartureDate,
} from "./search-params";

const base = { from: "waw", to: "lis", depart: "2026-11-10" };

const NO_FILTERS = {
  max_stops: null,
  airlines: [],
  excluded_airlines: [],
  departure_periods: [],
  departure_hours: null,
  arrival_periods: [],
  arrival_hours: null,
  return_departure_periods: [],
  return_departure_hours: null,
  return_arrival_periods: [],
  return_arrival_hours: null,
  max_duration_hours: null,
  max_layover_hours: null,
  min_layover_min: null,
  min_self_transfer_min: null,
  max_price: null,
  max_total_price: null,
};

describe("parseSearchParams", () => {
  it("повертає null, поки пошук не задано", () => {
    expect(parseSearchParams({})).toBeNull();
  });

  it("кілька аеропортів: повторювані й через кому, без повторів, до 4, туди й назад", () => {
    const state = parseSearchParams({
      from: ["ams", "RTM,EIN", "AMS"],
      to: "BCN",
      depart: "2026-12-05",
    });
    expect(state?.query).toMatchObject({
      origin: "AMS",
      origin_also: ["RTM", "EIN"],
      destination: "BCN",
      destination_also: [],
    });
    expect(toSearchParams(state!).toString()).toBe(
      "from=AMS&from=RTM&from=EIN&to=BCN&depart=2026-12-05",
    );
    // Той самий аеропорт з обох боків — не пошук.
    expect(parseSearchParams({ from: ["AMS", "BCN"], to: "BCN", depart: "2026-12-05" })).toBeNull();
  });

  it("нормалізує коди та застосовує значення за замовчуванням", () => {
    expect(parseSearchParams(base)).toEqual({
      query: {
        origin: "WAW",
        destination: "LIS",
        origin_also: [],
        destination_also: [],
        departure_date: "2026-11-10",
        return_date: null,
        flex_days: 0,
        departure_until: null,
        min_nights: null,
        max_nights: null,
        passengers: { adults: 1, children: 0, infants: 0, infants_in_seat: 0 },
        cabin: "economy",
        baggage: "none",
        direct_only: false,
        weekends: false,
        currency: "EUR",
        profile: "balanced",
        origin_radius_km: 0,
        destination_radius_km: 0,
        filters: NO_FILTERS,
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

    expect(state?.query.filters).toEqual({ ...NO_FILTERS, airlines: ["FR"] });
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

  it("trip=ow (форма без JS) — в один бік, навіть із заповненим поверненням", () => {
    const state = parseSearchParams({
      from: "WAW",
      to: "LIS",
      depart: "2026-12-05",
      return: "2026-12-12",
      trip: "ow",
    });

    expect(state?.query.return_date).toBeNull();
    expect(toSearchParams(state!).toString()).toBe("from=WAW&to=LIS&depart=2026-12-05");
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
      ...NO_FILTERS,
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

describe("пасажири й клас", () => {
  it("склад і клас переживають URL туди й назад", () => {
    const state = parseSearchParams({
      ...base,
      adults: "2",
      children: "1",
      lap: "1",
      seat: "1",
      cabin: "business",
    });
    expect(state?.query.passengers).toEqual({
      adults: 2,
      children: 1,
      infants: 1,
      infants_in_seat: 1,
    });
    expect(state?.query.cabin).toBe("business");
    const params = toSearchParams(state!);
    expect(Object.fromEntries(params)).toMatchObject({
      adults: "2",
      children: "1",
      lap: "1",
      seat: "1",
      cabin: "business",
    });
  });

  it("ручна правка URL не дає невалідного складу: як правила API", () => {
    // Немовлят на руках — не більше дорослих; разом — до 9.
    expect(parsePassengers({ adults: "1", lap: "3" })).toMatchObject({ adults: 1, infants: 1 });
    expect(parsePassengers({ adults: "1", lap: "1", seat: "5" }).infants_in_seat).toBe(1);
    const crowd = parsePassengers({ adults: "5", children: "8" });
    expect(crowd.adults + crowd.children).toBe(9);
    expect(parseSearchParams({ ...base, cabin: "space" })?.query.cabin).toBe("economy");
  });
});

describe("розширені фільтри в URL", () => {
  it("час туди й назад, власний діапазон, пересадки, бюджет, виключення — туди й назад", () => {
    const state = parseSearchParams({
      ...base,
      return: "2026-11-17",
      dep: "morning",
      deph: "21-2",
      arr: "evening",
      rdep: "afternoon",
      rarrh: "18-23",
      maxlay: "6",
      minlay: "60",
      minself: "180",
      maxt: "900",
      xal: "fr,w6",
      cur: "usd",
    })!;
    expect(state.query.currency).toBe("USD");

    expect(state.query.filters).toEqual({
      ...NO_FILTERS,
      excluded_airlines: ["FR", "W6"],
      departure_periods: ["morning"],
      departure_hours: { start: 21, end: 2 },
      arrival_periods: ["evening"],
      return_departure_periods: ["afternoon"],
      return_arrival_hours: { start: 18, end: 23 },
      max_layover_hours: 6,
      min_layover_min: 60,
      min_self_transfer_min: 180,
      max_total_price: 900,
    });
    expect(parseSearchParams(Object.fromEntries(toSearchParams(state)))).toEqual(state);
  });

  it("діапазон з форми без JS (From/To) і биті значення", () => {
    const fromForm = parseSearchParams({ ...base, arrhFrom: "6", arrhTo: "12" });
    expect(fromForm?.query.filters?.arrival_hours).toEqual({ start: 6, end: 12 });
    expect(toSearchParams(fromForm!).get("arrh")).toBe("6-12");

    const broken = parseSearchParams({
      ...base,
      deph: "5-5",
      arrh: "x-3",
      maxlay: "7",
      minlay: "-1",
      maxt: "0",
      xal: "!!",
      cur: "XYZ",
    });
    expect(broken?.query.currency).toBe("EUR");
    expect(broken?.query.filters).toEqual(NO_FILTERS);
  });
});

describe("гнучкі дати в URL", () => {
  const rt = { from: "WAW", to: "LIS", depart: "2026-12-10", return: "2026-12-14" };

  it("увесь місяць: з 1-го до останнього, тривалість поїздки зберігається", () => {
    const state = parseSearchParams({ ...rt, flex: "month" })!;
    expect(state.query).toMatchObject({
      departure_date: "2026-12-01",
      departure_until: "2026-12-31",
      return_date: "2026-12-05",
      flex_days: 0,
    });
    expect(toSearchParams(state).get("flex")).toBe("month");
    expect(toSearchParams(state).get("until")).toBeNull();
  });

  it("свій період до 62 днів; довший чи битий — точні дати", () => {
    const state = parseSearchParams({ ...rt, flex: "range", until: "2026-12-20" })!;
    expect(state.query.departure_until).toBe("2026-12-20");
    expect(Object.fromEntries(toSearchParams(state))).toMatchObject({
      flex: "range",
      until: "2026-12-20",
    });
    expect(
      parseSearchParams({ ...rt, flex: "range", until: "2027-03-01" })?.query.departure_until,
    ).toBeNull();
    expect(
      parseSearchParams({ ...rt, flex: "range", until: "2026-12-01" })?.query.departure_until,
    ).toBeNull();
    expect(parseSearchParams({ ...rt, flex: "3" })?.query.flex_days).toBe(3);
  });
});

describe("пошук за кількістю ночей у URL", () => {
  const month = { from: "WAW", to: "LIS", depart: "2026-12-10", flex: "month" };

  it("місяць + ночі: повернення = 1-ше + мінімум, туди й назад без дати повернення", () => {
    const state = parseSearchParams({ ...month, nmin: "3", nmax: "5", maxt: "400" })!;
    expect(state.query).toMatchObject({
      departure_date: "2026-12-01",
      departure_until: "2026-12-31",
      return_date: "2026-12-04",
      min_nights: 3,
      max_nights: 5,
    });
    expect(state.query.filters?.max_total_price).toBe(400);
    expect(parseSearchParams(Object.fromEntries(toSearchParams(state)))).toEqual(state);
  });

  it("ночі без періоду, в один бік чи биті — ігноруються", () => {
    const exact = parseSearchParams({
      ...month,
      flex: "0",
      return: "2026-12-14",
      nmin: "3",
      nmax: "5",
    });
    expect(exact?.query.min_nights).toBeNull();
    const oneWay = parseSearchParams({ ...month, trip: "ow", nmin: "3", nmax: "5" });
    expect(oneWay?.query).toMatchObject({ min_nights: null, return_date: null });
    expect(parseSearchParams({ ...month, nmin: "6", nmax: "3" })?.query.min_nights).toBeNull();
  });
});
