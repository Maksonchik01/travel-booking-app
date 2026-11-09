import { describe, expect, it } from "vitest";

import { fractionDigits } from "./money";

describe("округлення грошей у UI (модуль 18.2)", () => {
  it.each([
    [88, 0],
    [88.4, 2],
    [120.5, 2],
    [39.6, 2],
    [100.004, 0], // до центів — це 100,00
    ["93.04", 2],
  ])("%s → %i знаків", (value, digits) => {
    expect(fractionDigits(value)).toEqual({
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  });

  it("не показує дробову ціну цілою", () => {
    const format = (v: number) =>
      new Intl.NumberFormat("uk", {
        style: "currency",
        currency: "EUR",
        currencyDisplay: "narrowSymbol",
        ...fractionDigits(v),
      }).format(v);
    expect(format(88.4)).toMatch(/88,40/);
    expect(format(88)).toMatch(/^88\s€$/);
  });
});
