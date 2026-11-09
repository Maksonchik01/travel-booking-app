import type { Offer, OfferScore, Stay, StayScore } from "@tickets/shared";
import { describe, expect, it } from "vitest";

import { sortOffers, sortStays } from "./sort";

const offer = (id: string, price: number, duration: number | null) =>
  ({ id, source: "t", price, total_duration_min: duration }) as Offer;
const score = (key: string, total: number | null) =>
  [key, { offer_key: key, breakdown: { total } } as OfferScore] as const;

describe("сортування перельотів (модуль 21.1)", () => {
  const offers = [offer("a", 100, 600), offer("b", 150, 200), offer("c", 120, null)];
  const scores = new Map([score("t:a", 180), score("t:b", 160), score("t:c", null)]);

  it("за ціною — порядок API (від дешевших), без змін", () => {
    expect(sortOffers(offers, "price", scores).map((o) => o.id)).toEqual(["a", "b", "c"]);
  });

  it("швидші першими; невідома тривалість — у кінці, не попереду", () => {
    expect(sortOffers(offers, "duration", scores).map((o) => o.id)).toEqual(["b", "a", "c"]);
  });

  it("вигідніші — за оцінкою; без оцінки — у кінці", () => {
    expect(sortOffers(offers, "score", scores).map((o) => o.id)).toEqual(["b", "a", "c"]);
  });

  it("за часом вильоту — місцевий час з ISO; рівні лишаються за ціною (модуль 22.5)", () => {
    const at = (id: string, price: number, departure_at: string) =>
      ({ id, source: "t", price, outbound: { departure_at } }) as Offer;
    const byDeparture = [
      at("late", 50, "2026-12-12T21:05:00+01:00"),
      at("early", 90, "2026-12-12T06:40:00+01:00"),
      at("early-dearer", 120, "2026-12-12T06:40:00+01:00"),
      at("next-day", 40, "2026-12-13T05:00:00+01:00"),
    ];
    expect(sortOffers(byDeparture, "departure", scores).map((o) => o.id)).toEqual([
      "early",
      "early-dearer",
      "late",
      "next-day",
    ]);
  });

  it("не змінює вхідний масив", () => {
    const copy = [...offers];
    sortOffers(offers, "duration", scores);
    expect(offers).toEqual(copy);
  });
});

describe("сортування житла (модуль 21.2)", () => {
  const stay = (id: string, price: number) => ({ id, source: "t", price_per_night: price }) as Stay;
  const stays = [stay("a", 80), stay("b", 120), stay("c", 100)];
  const scores = new Map<string, StayScore>([
    ["t:a", { breakdown: { total: 110, adjusted_rating: 7.1 } } as StayScore],
    ["t:b", { breakdown: { total: 125, adjusted_rating: 9.2 } } as StayScore],
  ]);

  it("за рейтингом (скоригованим) — найкращі першими, без оцінок — у кінці", () => {
    expect(sortStays(stays, "rating", scores).map((s) => s.id)).toEqual(["b", "a", "c"]);
  });

  it("вигідніші — за оцінкою value-score", () => {
    expect(sortStays(stays, "score", scores).map((s) => s.id)).toEqual(["a", "b", "c"]);
  });
});
