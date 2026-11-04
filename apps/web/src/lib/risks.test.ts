import { describe, expect, it } from "vitest";

import { layoverRisks } from "./risks";

const base = { airport: "FRA", duration_min: 120, overnight: false, self_transfer: false };

describe("layoverRisks", () => {
  it("звичайна пересадка без ризиків", () => {
    expect(layoverRisks(base)).toEqual([]);
  });

  it("позначає коротку, довгу, нічну та самостійну", () => {
    expect(layoverRisks({ ...base, duration_min: 40, self_transfer: true })).toEqual([
      "short",
      "selfTransfer",
    ]);
    expect(layoverRisks({ ...base, duration_min: 540, overnight: true })).toEqual([
      "long",
      "overnight",
    ]);
  });

  it("межі: рівно 60 хв і рівно 8 год — не ризик", () => {
    expect(layoverRisks({ ...base, duration_min: 60 })).toEqual([]);
    expect(layoverRisks({ ...base, duration_min: 480 })).toEqual([]);
  });
});
