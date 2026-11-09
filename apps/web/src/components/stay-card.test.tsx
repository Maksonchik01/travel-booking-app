import type { Stay, StayAnalysisResult, StayQuery, StayScore } from "@tickets/shared";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import messages from "../../messages/uk.json";
import { StayAnalysis } from "./stay-analysis";
import { StayCard } from "./stay-card";

const NOW = new Date("2026-11-06T12:00:00Z");

const STAY: Stay = {
  id: "mock-lis-1",
  source: "mock",
  name: "Hotel Meridian",
  kind: "hotel",
  stars: 4,
  price_per_night: 120.5,
  total_price: 361.5,
  currency: "EUR",
  nights: 3,
  rooms: 1,
  rating: 8.6,
  review_count: 1350,
  latitude: null,
  longitude: null,
  distance_to_center_km: 1.4,
  distance_to_transit_m: 300,
  cancellation: "free",
  free_cancellation_until: null,
  amenities: ["wifi", "breakfast"],
  district: "Центр",
  image_url: null,
  deep_link: null,
  seller: null,
  collected_at: "2026-11-06T10:00:00Z",
  found_at: "2026-11-06T10:00:00Z",
};

const SCORE: StayScore = {
  stay_key: "mock:mock-lis-1",
  breakdown: {
    price: 120.5,
    distance_penalty: 3.2,
    transit_penalty: 0,
    rating_penalty: 6.15,
    cancellation_penalty: 0,
    amenity_penalty: 4,
    missing_amenities: ["parking"],
    adjusted_rating: 8.59,
    total: 129.85,
  },
  warnings: [{ code: "few_reviews" }],
  pareto_optimal: true,
  reasons: [
    { code: "pricier_but_closer", vs: "cheapest", amount: 30, km: 2.6 },
    { code: "cheaper_than_top_rated", vs: "top_rated", amount: 45, rating: 0.4 },
    { code: "within_budget", amount: 38 },
  ],
};

const QUERY: StayQuery = {
  city: "LIS",
  check_in: "2026-12-05",
  check_out: "2026-12-08",
  guests: { adults: 2, children: 0, rooms: 1 },
  currency: "EUR",
  profile: "balanced",
  filters: {
    free_cancellation: false,
    breakfast_included: false,
    no_prepayment: false,
    pay_at_property: false,
  },
};

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("StayCard", () => {
  it("ціна за ніч і за весь період, рейтинг словом, відстані та скасування", () => {
    wrap(<StayCard stay={STAY} now={NOW} pickLabel="balanced" score={SCORE} />);

    // Копійки не ховаємо (модуль 18.2): 120,50 — не «121».
    expect(screen.getByTestId("stay-price")).toHaveTextContent("120,50 €");
    expect(screen.getByTestId("stay-total")).toHaveTextContent("361,50 € за 3 ночі");
    expect(screen.getByTestId("stay-rating")).toHaveTextContent(/8,6Дуже добре· 1\s350 відгуків/);
    expect(screen.getByText("1,4 км до центру")).toBeInTheDocument();
    expect(screen.getByText("300 м до транспорту")).toBeInTheDocument();
    expect(screen.getByText("Безкоштовне скасування")).toBeInTheDocument();
    expect(screen.getByTestId("stay-pick-label")).toHaveTextContent("Збалансований");
    const breakdown = screen.getByTestId("stay-breakdown");
    expect(within(breakdown).getByTestId("stay-total-score")).toHaveTextContent("129,85 €");
    expect(screen.getByText("Мало відгуків — оцінка ненадійна")).toBeInTheDocument();
    // «Чому цей варіант?»: конкретні порівняння й бажані зручності (модуль 14).
    expect(screen.getByText("Чому цей варіант?")).toBeInTheDocument();
    const why = screen.getByTestId("stay-why-reasons");
    expect(why).toHaveTextContent(
      "На 30 € дорожчий за найдешевший, але на 2,6 км ближче до центру",
    );
    expect(why).toHaveTextContent(
      "На 45 € дешевший за найкраще оцінений, рейтинг нижчий лише на 0,4",
    );
    expect(why).toHaveTextContent("У межах бюджету, запас 38 €");
    expect(breakdown).toHaveTextContent("Бракує бажаного: Парковка+4 €");
  });

  it("невідоме — так і пишемо, а не «ні»", () => {
    wrap(
      <StayCard
        stay={{ ...STAY, cancellation: null, distance_to_center_km: null, rating: null }}
        now={NOW}
      />,
    );

    expect(screen.getByText("Умови скасування невідомі")).toBeInTheDocument();
    expect(screen.getByText("Відстань до центру невідома")).toBeInTheDocument();
    expect(screen.getByText("Ще немає оцінок")).toBeInTheDocument();
  });
});

describe("StayAnalysis", () => {
  it("резюме відгуків лише на вимогу, з позначкою ненадійності", async () => {
    const result: StayAnalysisResult = {
      status: "ok",
      analysis: {
        stays: [
          {
            id: "mock-lis-1",
            pros: ["Чисто"],
            cons: ["Шумно вночі"],
            red_flags: ["Про шум пишуть 6 з 30"],
            reliability: "low",
            reliability_note: "",
            best_for: "для коротких поїздок",
          },
        ],
        top_pick_id: "mock-lis-1",
        top_pick_reason: "Найкраще поєднання ціни й розташування.",
        price_vs_location_note: "",
        flags: [],
      },
    };
    const analyze = vi.fn(async () => result);
    wrap(<StayAnalysis query={QUERY} stays={[STAY]} analyze={analyze} />);
    expect(screen.queryByTestId("stay-analysis")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Підсумувати відгуки" }));
    });

    expect(analyze).toHaveBeenCalledWith(QUERY, ["mock:mock-lis-1"]);
    const block = screen.getByTestId("stay-analysis");
    expect(block).toHaveTextContent("Радимо: Hotel Meridian.");
    expect(block).toHaveTextContent("Мало відгуків — оцінка ненадійна");
    expect(block).toHaveTextContent("Про шум пишуть 6 з 30");
  });
});
