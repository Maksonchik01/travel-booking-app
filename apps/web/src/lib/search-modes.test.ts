import { describe, expect, it } from "vitest";

import { commonFrom, modeHref } from "@/lib/search-modes";

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
