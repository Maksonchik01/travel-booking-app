import { describe, expect, it } from "vitest";

import { dayShift, daysAgo, hoursAgo, localTime, splitDuration } from "./format";

describe("format", () => {
  it("показує час у поясі аеропорту без перерахунку", () => {
    expect(localTime("2026-11-10T06:15:00+01:00")).toBe("06:15");
    expect(localTime("2026-11-10T23:35:00Z")).toBe("23:35");
  });

  it("рахує перехід через північ", () => {
    expect(dayShift("2026-11-10T23:35:00Z", "2026-11-11T04:10:00Z")).toBe(1);
    expect(dayShift("2026-11-10T06:00:00Z", "2026-11-10T09:00:00Z")).toBe(0);
  });

  it("розбиває тривалість на години й хвилини", () => {
    expect(splitDuration(245)).toEqual({ hours: 4, minutes: 5 });
  });

  it("рахує повні години від моменту знаходження ціни", () => {
    const now = new Date("2026-10-26T12:00:00Z");

    expect(hoursAgo("2026-10-26T09:30:00Z", now)).toBe(2);
    expect(hoursAgo("2026-10-26T12:30:00Z", now)).toBe(0);
  });

  it("рахує календарні дні від дати знаходження ціни", () => {
    const now = new Date("2026-11-02T09:00:00Z");

    expect(daysAgo("2026-11-02", now)).toBe(0);
    expect(daysAgo("2026-11-01", now)).toBe(1);
    expect(daysAgo("2026-10-30", now)).toBe(3);
  });
});
