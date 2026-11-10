import { beforeEach, describe, expect, it } from "vitest";

import { commonFrom, modeHref, rememberSearch, returnHref } from "@/lib/search-modes";

describe("search modes", () => {
  it("переносить місто, дати й людей між режимами", () => {
    const flights = commonFrom(
      "flights",
      new URLSearchParams(
        "from=waw&to=LIS&depart=2026-12-05&return=2026-12-08&adults=2&cabin=business",
      ),
    );
    expect(flights).toEqual({
      from: "WAW",
      to: "LIS",
      depart: "2026-12-05",
      return: "2026-12-08",
      adults: 2,
    });
    expect(modeHref("stays", flights)).toBe(
      "/stays?city=LIS&in=2026-12-05&out=2026-12-08&adults=2",
    );
    expect(modeHref("trip", flights)).toBe(
      "/trip?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-08&adults=2",
    );

    const stays = commonFrom("stays", {
      city: "LIS",
      in: "2026-12-05",
      out: "2026-12-08",
      children: "1",
    });
    expect(modeHref("flights", stays)).toBe(
      "/?to=LIS&depart=2026-12-05&return=2026-12-08&children=1",
    );
  });

  it("в один бік — без повернення; биті значення й порожнє — просто сторінка режиму", () => {
    const form = new FormData();
    form.set("trip", "ow");
    form.set("to", "BCN");
    form.set("depart", "2026-12-10");
    form.set("return", "2026-12-12");
    expect(modeHref("stays", commonFrom("flights", form))).toBe("/stays?city=BCN&in=2026-12-10");
    expect(commonFrom("trip", { to: "Barcelona", depart: "10.12", adults: "20" })).toEqual({});
    expect(modeHref("trip", {})).toBe("/trip");
  });
});

describe("повернення в розділ (модуль 23b)", () => {
  beforeEach(() => sessionStorage.clear());
  const trip =
    "/trip?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-08&adults=2&flight=mock:1&stay=mock:7";

  it("та сама подорож — повертає збережений пошук з вибором рейсу й житла", () => {
    rememberSearch("trip", trip);
    const fromFlights = commonFrom(
      "flights",
      new URLSearchParams("from=WAW&to=LIS&depart=2026-12-05&return=2026-12-08&adults=2"),
    );
    expect(returnHref("trip", fromFlights)).toBe(trip);
  });

  it("інший маршрут чи дати — новий пошук, а не стара поїздка", () => {
    rememberSearch("trip", trip);
    expect(returnHref("trip", { from: "WAW", to: "BCN", depart: "2026-12-05" })).toBe(
      "/trip?from=WAW&to=BCN&depart=2026-12-05",
    );
    expect(returnHref("trip", { from: "WAW", to: "LIS", depart: "2026-12-06" })).toMatch(
      /depart=2026-12-06/,
    );
  });

  it("житло без «звідки» — та сама подорож за містом і датами", () => {
    rememberSearch("stays", "/stays?city=LIS&in=2026-12-05&out=2026-12-08&adults=2&cancel=1");
    expect(
      returnHref("stays", {
        from: "WAW",
        to: "LIS",
        depart: "2026-12-05",
        return: "2026-12-08",
        adults: 2,
      }),
    ).toBe("/stays?city=LIS&in=2026-12-05&out=2026-12-08&adults=2&cancel=1");
  });
});
