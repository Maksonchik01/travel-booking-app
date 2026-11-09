import { beforeEach, describe, expect, it } from "vitest";

import { MAX_RECENT, clearRecent, readRecent, recentHref, rememberSearch } from "./recent-searches";

beforeEach(() => localStorage.clear());

describe("останні пошуки (модуль 20.3)", () => {
  it("той самий пошук піднімається нагору без дублів", () => {
    rememberSearch({ kind: "flights", params: "from=WAW&to=LIS", title: "A" });
    rememberSearch({ kind: "stays", params: "city=LIS", title: "B" });
    rememberSearch({ kind: "flights", params: "from=WAW&to=LIS", title: "A2" });
    expect(readRecent().map((r) => r.title)).toEqual(["A2", "B"]);
  });

  it(`не більше ${MAX_RECENT}, найновіші першими`, () => {
    for (let i = 0; i < MAX_RECENT + 3; i++) {
      rememberSearch({ kind: "trip", params: `from=WAW&to=LIS&i=${i}`, title: String(i) });
    }
    const items = readRecent();
    expect(items).toHaveLength(MAX_RECENT);
    expect(items[0]!.title).toBe(String(MAX_RECENT + 2));
  });

  it("повторний пошук — на сторінку свого режиму; очистити — усе", () => {
    rememberSearch({ kind: "stays", params: "city=LIS&in=2026-12-05", title: "S" });
    expect(recentHref(readRecent()[0]!)).toBe("/stays?city=LIS&in=2026-12-05");
    clearRecent();
    expect(readRecent()).toEqual([]);
  });

  it("битий вміст сховища — порожньо, а не помилка", () => {
    localStorage.setItem("tickets.recentSearches", "{oops");
    expect(readRecent()).toEqual([]);
  });
});
