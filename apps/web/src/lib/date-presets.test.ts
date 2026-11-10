import { describe, expect, it } from "vitest";

import { datePreset, localToday } from "./date-presets";

// Середа, 11.11.2026.
const TODAY = "2026-11-11";

describe("швидкі дати (модуль 3)", () => {
  it("найближчі й наступні вихідні — пт → нд; у суботу «найближчі» вже наступні", () => {
    expect(datePreset("thisWeekend", TODAY)).toEqual({ depart: "2026-11-13", back: "2026-11-15" });
    expect(datePreset("nextWeekend", TODAY)).toEqual({ depart: "2026-11-20", back: "2026-11-22" });
    expect(datePreset("thisWeekend", "2026-11-14").depart).toBe("2026-11-20");
    expect(datePreset("thisWeekend", "2026-11-15").depart).toBe("2026-11-20");
  });

  it("вихідні місяця: без дати — наступний місяць, з датою — її місяць (не раніше завтра)", () => {
    expect(datePreset("monthWeekends", TODAY)).toEqual({
      depart: "2026-12-01",
      until: "2026-12-31",
      nights: [1, 3],
      weekends: true,
    });
    expect(datePreset("monthWeekends", TODAY, "2027-02-14")).toMatchObject({
      depart: "2027-02-01",
      until: "2027-02-28",
    });
    // Поточний місяць — з завтрашнього дня.
    expect(datePreset("monthWeekends", TODAY, "2026-11-20")).toMatchObject({
      depart: "2026-11-12",
      until: "2026-11-30",
    });
  });

  it("3–4 та 5–7 днів — ночі 2–3 і 4–6 у наступні 30 днів від обраної дати чи завтра", () => {
    expect(datePreset("short", TODAY)).toEqual({
      depart: "2026-11-12",
      until: "2026-12-12",
      nights: [2, 3],
    });
    expect(datePreset("week", TODAY, "2026-12-01")).toEqual({
      depart: "2026-12-01",
      until: "2026-12-31",
      nights: [4, 6],
    });
    // Минула дата як опора — від завтра.
    expect(datePreset("week", TODAY, "2026-11-01").depart).toBe("2026-11-12");
  });

  it("сьогодні — місцевий день, а не UTC", () => {
    const lateEvening = new Date(2026, 10, 11, 23, 30);
    expect(localToday(lateEvening)).toBe("2026-11-11");
  });
});
