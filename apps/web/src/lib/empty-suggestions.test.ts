import { describe, expect, it } from "vitest";

import { flightSuggestions, staySuggestions, tripSuggestions } from "./empty-suggestions";
import { draftHref, isDraft } from "./search-modes";
import { parseSearchParams } from "./search-params";
import { parseStayParams } from "./stay-params";
import { parseTripParams } from "./trip-params";

const keys = (items: { key: string }[]) => items.map((i) => i.key);

describe("порожні результати — альтернативи (модуль 20.5)", () => {
  it("перельоти: кожна пропозиція — той самий пошук з однією зміною", () => {
    const state = parseSearchParams({
      from: "WAW",
      to: "LIS",
      depart: "2026-12-05",
      stops: "0",
      maxp: "80",
    })!;
    const items = flightSuggestions(state);
    expect(keys(items)).toEqual([
      "widerDates",
      "allowStops",
      "nearby",
      "higherBudget",
      "fewerFilters",
    ]);
    const href = (key: string) =>
      new URLSearchParams(items.find((i) => i.key === key)!.href.slice(2));
    expect(href("widerDates").get("flex")).toBe("3");
    expect(href("widerDates").get("stops")).toBe("0"); // решта умов — як були
    expect(href("allowStops").has("stops")).toBe(false);
    expect(href("allowStops").get("maxp")).toBe("80");
    expect(href("nearby").get("fromNear")).toBe("1");
    expect(items.find((i) => i.key === "higherBudget")!.amount).toBe(100);
    expect(href("higherBudget").get("maxp")).toBe("100");
    expect(href("fewerFilters").get("from")).toBe("WAW");
  });

  it("нема чого послабити — нема й пропозиції", () => {
    const state = parseSearchParams({
      from: "WAW",
      to: "LIS",
      depart: "2026-12-05",
      flex: "3",
      fromNear: "1",
      toNear: "1",
    })!;
    expect(flightSuggestions(state)).toEqual([]);
  });

  it("житло: ширший район, більший бюджет, без фільтрів", () => {
    const state = parseStayParams({
      city: "LIS",
      in: "2026-12-05",
      out: "2026-12-08",
      dist: "1",
      maxp: "60",
    })!;
    expect(keys(staySuggestions(state))).toEqual(["widerArea", "higherBudget", "fewerFilters"]);
  });

  it("поїздка: дати, пересадки, сусідні аеропорти, умови житла", () => {
    const query = parseTripParams({
      from: "WAW",
      to: "LIS",
      depart: "2026-12-05",
      return: "2026-12-08",
      direct: "1",
      rating: "8",
    })!;
    expect(keys(tripSuggestions(query))).toEqual([
      "widerDates",
      "allowStops",
      "nearby",
      "fewerFilters",
    ]);
  });
});

describe("чернетка форми в адресі (модуль 20.4)", () => {
  it("лише з тим, що введено, і з позначкою draft", () => {
    const href = draftHref("flights", { to: "LIS", depart: "2026-12-05", adults: 2 });
    expect(href).toBe("/?to=LIS&depart=2026-12-05&adults=2&draft=1");
    expect(isDraft(new URLSearchParams(href.slice(2)))).toBe(true);
    expect(draftHref("stays", { adults: 2 })).toBe("/stays"); // порожня форма — чиста адреса
  });
});
