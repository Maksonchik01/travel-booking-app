import type { Offer, Stay, TripCombo } from "@tickets/shared";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import messages from "../../messages/uk.json";
import { TripCard } from "./trip-card";

const LEG = {
  origin: "WAW",
  destination: "LIS",
  departure_at: "2026-12-05T06:10:00+01:00",
  arrival_at: "2026-12-05T09:30:00+00:00",
  duration_min: 260,
  stops: 0,
  segments: null,
  layovers: [],
  flight_number: null,
};

const OFFER: Offer = {
  id: "f1",
  source: "mock",
  price: 88,
  currency: "EUR",
  outbound: LEG,
  inbound: {
    ...LEG,
    origin: "LIS",
    destination: "WAW",
    departure_at: "2026-12-08T10:00:00+00:00",
    arrival_at: "2026-12-08T15:20:00+01:00",
  },
  airlines: ["LO"],
  airline_logos: {},
  details_level: "full",
  baggage_included: null,
  collected_at: "2026-11-06T10:00:00Z",
  found_at: null,
  found_on: null,
  expires_at: null,
  deep_link: null,
  seller: null,
  reported_total_duration_min: null,
  stops: 0,
  total_duration_min: 520,
};

const STAY: Stay = {
  id: "s1",
  source: "mock",
  name: "Pension Rosa",
  kind: "guesthouse",
  stars: null,
  price_per_night: 77,
  total_price: 231,
  currency: "EUR",
  nights: 3,
  rating: 8.7,
  review_count: 480,
  latitude: null,
  longitude: null,
  distance_to_center_km: 2.2,
  distance_to_transit_m: 550,
  cancellation: "free",
  free_cancellation_until: null,
  amenities: [],
  district: null,
  image_url: null,
  deep_link: null,
  seller: null,
  collected_at: "2026-11-06T10:00:00Z",
  found_at: null,
};

const COMBO: TripCombo = {
  key: "mock:f1|mock:s1",
  offer_key: "mock:f1",
  stay_key: "mock:s1",
  window: { check_in: "2026-12-05", check_out: "2026-12-08", nights: 3 },
  flight_price: 88,
  flight_total: 176,
  stay_total: 231,
  money_total: 407,
  value_total: 480.5,
  currency: "EUR",
  warnings: ["children_not_priced"],
};

describe("TripCard", () => {
  it("загальна сума з розбивкою, рейс, житло і посилання на деталі", () => {
    render(
      <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
        <TripCard
          combo={COMBO}
          offer={OFFER}
          stay={STAY}
          adults={2}
          label="best_value"
          also={["cheapest"]}
          airlineNames={{ LO: "LOT Polish" }}
          flightsHref="/?from=WAW&to=LIS"
          staysHref="/stays?city=LIS"
        />
      </NextIntlClientProvider>,
    );

    expect(screen.getByText("Найвигідніша поїздка")).toBeInTheDocument();
    expect(screen.getByText("також найдешевша")).toBeInTheDocument();
    expect(screen.getByTestId("trip-total")).toHaveTextContent("407 €");
    const breakdown = screen.getByTestId("trip-breakdown");
    expect(breakdown).toHaveTextContent("Переліт: 2 × 88 €176 €");
    expect(breakdown).toHaveTextContent("Житло, 3 ночі231 €");
    expect(screen.getByText("Pension Rosa")).toBeInTheDocument();
    expect(screen.getByText("Без дитячих квитків")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Рейс/ })).toHaveAttribute(
      "href",
      "/?from=WAW&to=LIS#offer-mock-f1",
    );
    expect(screen.getByRole("link", { name: /Житло/ })).toHaveAttribute(
      "href",
      "/stays?city=LIS#stay-mock-s1",
    );
  });
});
