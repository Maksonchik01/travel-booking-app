import type { ExploreDestination } from "@tickets/shared";
import { describe, expect, it } from "vitest";

import {
  dateWindow,
  exploreFromFlights,
  exploreHref,
  exploreRelaxations,
  featuredPicks,
  flightsHref,
  parseExploreDraft,
  parseExploreParams,
  toggleCategory,
  tripHref,
  windowOf,
} from "./explore-params";

const DEST = {
  code: "DUB",
  city_name: "Дублін",
  country: "IE",
  categories: ["city"],
  nights: 2,
  freshness: "cached",
  offer: {
    id: "x",
    source: "travelpayouts",
    price: 144,
    currency: "EUR",
    outbound: {
      origin: "AMS",
      destination: "DUB",
      departure_at: "2026-12-14T12:40:00+01:00",
      stops: 0,
    },
    inbound: { origin: "DUB", destination: "AMS", departure_at: "2026-12-16T09:30:00Z", stops: 0 },
  },
} as unknown as ExploreDestination;

/** Адреса → той самий запит (повторювані параметри — масивом, як у searchParams Next). */
function roundTrip(href: string) {
  const params = new URLSearchParams(href.split("?")[1]);
  const raw: Record<string, string[]> = {};
  for (const key of new Set(params.keys())) raw[key] = params.getAll(key);
  return parseExploreParams(raw);
}

describe("explore params (ADR 0045)", () => {
  it("гнучкий пошук: кілька аеропортів, регіон, категорії, бюджет — і назад", () => {
    const query = parseExploreParams({
      from: ["ams", "RTM,EIN"],
      to: "europe",
      depart: "2026-12-01",
      until: "2026-12-31",
      nmin: "2",
      nmax: "4",
      adults: "2",
      budget: "300",
      mode: "trip",
      cat: ["sea", "city", "nope"],
      wk: "1",
    });

    expect(query).toMatchObject({
      origins: ["AMS", "RTM", "EIN"],
      region: "europe",
      departure_until: "2026-12-31",
      min_nights: 2,
      max_nights: 4,
      adults: 2,
      budget: 300,
      mode: "trip",
      categories: ["sea", "city"],
      weekends: true,
    });
    expect(roundTrip(exploreHref(query!))).toEqual(query);
  });

  it("країна — ISO2, точні дати — return; без повернення чи з задовгим періодом — null", () => {
    expect(
      parseExploreParams({ from: "WAW", to: "es", depart: "2026-12-05", return: "2026-12-08" }),
    ).toMatchObject({ country: "ES", return_date: "2026-12-08" });
    expect(parseExploreParams({ from: "WAW", depart: "2026-12-05" })).toBeNull();
    expect(
      parseExploreParams({ from: "WAW", depart: "2026-12-05", until: "2027-04-01" }),
    ).toBeNull();
    expect(parseExploreParams({ depart: "2026-12-05", return: "2026-12-08" })).toBeNull();
  });

  it("чернетка: категорія з головної без міста — лише в форму", () => {
    expect(parseExploreDraft({ cat: "sea" })).toEqual({ categories: ["sea"] });
    expect(parseExploreParams({ cat: "sea" })).toBeNull();
  });

  it("переходи: рейси й поїздка з тими самими датами, людьми й бюджетом", () => {
    const query = parseExploreParams({
      from: "AMS",
      depart: "2026-12-01",
      until: "2026-12-31",
      adults: "2",
      budget: "500",
    })!;

    expect(flightsHref(DEST, query)).toBe(
      "/?from=AMS&to=DUB&depart=2026-12-14&return=2026-12-16&adults=2",
    );
    expect(tripHref(DEST, query)).toBe(
      "/trip?from=AMS&to=DUB&depart=2026-12-14&return=2026-12-16&adults=2&budget=500",
    );
  });

  it("«Будь-куди» з пошуку рейсів переносить звідки, дати, людей і «прямі»", () => {
    const form = new URLSearchParams({
      from: "waw",
      to: "LIS",
      depart: "2026-12-05",
      return: "2026-12-08",
      adults: "2",
      direct: "1",
    });
    expect(exploreFromFlights(form)).toBe(
      "/explore?from=WAW&depart=2026-12-05&return=2026-12-08&adults=2&direct=1",
    );
    // В один бік — гнучкий місяць від дати вильоту.
    form.set("trip", "ow");
    expect(exploreFromFlights(form)).toContain("depart=2026-12-05&until=2027-01-04");
  });

  it("послаблення — по одній зміні; категорія вмикається й вимикається", () => {
    const query = parseExploreParams({
      from: "AMS",
      to: "ES",
      depart: "2026-12-05",
      return: "2026-12-08",
      budget: "100",
      cat: "sea",
      direct: "1",
    })!;
    const relax = exploreRelaxations(query);

    expect(relax.map((r) => r.key)).toEqual([
      "budget",
      "direct",
      "categories",
      "anywhere",
      "flexible",
    ]);
    expect(relax[0].query).toEqual({ ...query, budget: undefined });
    expect(relax[4].query).toMatchObject({
      return_date: undefined,
      departure_until: "2027-01-04",
      min_nights: 2,
      max_nights: 5,
    });
    expect(toggleCategory(query, "sea").categories).toEqual([]);
    expect(toggleCategory(query, "city").categories).toEqual(["sea", "city"]);
  });

  it("дата ± похибка ↔ період вильоту; минулі дні відрізаємо", () => {
    expect(dateWindow("2026-12-10", 7, "2026-11-11")).toEqual({
      depart: "2026-12-03",
      until: "2026-12-17",
    });
    expect(dateWindow("2026-11-12", 3, "2026-11-11")).toEqual({
      depart: "2026-11-11",
      until: "2026-11-15",
    });
    expect(dateWindow("2026-12-10", 0, "2026-11-11").until).toBe("2026-12-10");
    expect(
      windowOf({ departure_date: "2026-12-03", departure_until: "2026-12-17" }, "2026-11-11"),
    ).toMatchObject({ center: "2026-12-10", tolerance: 7 });
    // Точні дати (старі посилання, чат) — похибки немає, ночі — рівно між датами.
    expect(
      windowOf({ departure_date: "2026-12-05", return_date: "2026-12-08" }, "2026-11-11"),
    ).toEqual({ center: "2026-12-05", tolerance: 0, nights: [3, 3] });
    expect(windowOf({}, "2026-11-11")).toEqual({
      center: "2026-12-02",
      tolerance: 7,
      nights: [2, 4],
    });
  });

  it("пропозиції: головна — найдешевша з фото, схожі — спершу зі спільною категорією", () => {
    const photo = { url: "https://upload.wikimedia.org/x.jpg", page: "https://en.wikipedia.org" };
    const make = (code: string, categories: string[], withPhoto = true) =>
      ({ ...DEST, code, categories, photo: withPhoto ? photo : null }) as ExploreDestination;
    const list = [
      make("AAA", ["sea"], false),
      make("BCN", ["city", "sea"]),
      make("OSL", ["mountains"]),
      make("LIS", ["sea"]),
      make("PRG", ["city"]),
    ];
    const picks = featuredPicks(list)!;
    expect(picks.hero.code).toBe("BCN");
    expect(picks.cheapest).toBe(false);
    expect(picks.similar.map((d) => d.code)).toEqual(["LIS", "PRG", "OSL"]);
    expect(featuredPicks([make("X", [], false)])).toBeNull();
  });
});
