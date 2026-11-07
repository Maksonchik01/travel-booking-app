import type { Offer, ScoringResult } from "@tickets/shared";
import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import messages from "../../messages/uk.json";
import { TopPicks } from "./top-picks";

function offer(id: string, price: number, duration: number | null, stops: number): Offer {
  return {
    id,
    source: "mock",
    price,
    currency: "EUR",
    outbound: {
      origin: "WAW",
      destination: "LIS",
      departure_at: "2026-11-10T08:00:00+01:00",
      arrival_at: null,
      duration_min: duration,
      stops,
      segments: null,
      layovers: null,
      flight_number: null,
    },
    inbound: null,
    airlines: [],
    airline_logos: {},
    details_level: "summary",
    baggage_included: null,
    collected_at: "2026-11-01T10:00:00Z",
    found_at: null,
    expires_at: null,
    deep_link: null,
    price_status: "cached",
    found_on: null,
    seller: null,
    reported_total_duration_min: null,
    stops,
    total_duration_min: duration,
  };
}

const offers = [offer("A", 90, 360, 1), offer("B", 180, 180, 0)];

const scoring: ScoringResult = {
  profile: "balanced",
  currency: "EUR",
  min_duration_min: 180,
  scores: [
    {
      offer_key: "mock:A",
      pareto_optimal: true,
      breakdown: {
        price: 90,
        time_penalty: 45,
        stop_penalty: 30,
        risk_penalties: [{ code: "night_departure", leg: "outbound", amount: 20, airport: "WAW" }],
        risk_total: 20,
        total: 185,
      },
      warnings: [{ code: "layover_details_unknown", leg: "outbound", airport: null }],
    },
    {
      offer_key: "mock:B",
      pareto_optimal: true,
      breakdown: {
        price: 180,
        time_penalty: 0,
        stop_penalty: 0,
        risk_penalties: [],
        risk_total: 0,
        total: 180,
      },
      warnings: [],
    },
  ],
  picks: [
    { label: "cheapest", offer_key: "mock:A", also: [] },
    { label: "balanced", offer_key: "mock:B", also: ["fastest"] },
  ],
  unscored_offer_keys: [],
  cheapest_basis: "ticket",
};

function renderPicks(s: ScoringResult = scoring) {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
      <TopPicks scoring={s} offers={offers} />
    </NextIntlClientProvider>,
  );
}

describe("TopPicks", () => {
  it("показує кожну номінацію один раз, збалансований — з приміткою про інші", () => {
    renderPicks();

    const picks = screen.getAllByTestId("top-pick");
    expect(picks.map((p) => p.dataset.label)).toEqual(["cheapest", "balanced"]);
    expect(within(picks[1]!).getByText("також найшвидший")).toBeInTheDocument();
    expect(screen.getByText(/Профіль «Баланс»/)).toBeInTheDocument();
  });

  it("розкладає оцінку на складові з ризиками та попередженнями", () => {
    renderPicks();

    const cheapest = screen.getAllByTestId("top-pick")[0]!;
    const breakdown = within(cheapest).getByTestId("breakdown");
    expect(breakdown).toHaveTextContent("+45 €");
    expect(breakdown).toHaveTextContent("Нічний виліт з WAW");
    expect(within(cheapest).getByTestId("total")).toHaveTextContent("185 €");
    expect(within(cheapest).getByText("Деталі пересадок невідомі")).toBeInTheDocument();
  });

  it("чесно пише, коли оцінку не порахувати", () => {
    const unknown = structuredClone(scoring);
    unknown.scores[0]!.breakdown.total = null;
    unknown.scores[0]!.breakdown.time_penalty = null;
    renderPicks(unknown);

    expect(screen.getByText("Не порахувати: тривалість невідома")).toBeInTheDocument();
  });

  it("нічого не рендерить без вибору", () => {
    const { container } = renderPicks({ ...scoring, picks: [] });

    expect(container).toBeEmptyDOMElement();
  });
});
