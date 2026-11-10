import type { Offer, Stay, TripCombo } from "@tickets/shared";
import { render, screen, within } from "@testing-library/react";
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
  price_status: "cached",
  seller: null,
  reported_total_duration_min: null,
  separate_tickets: false,
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
  rooms: 1,
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
  taxes_included: true,
};

const COMBO: TripCombo = {
  key: "mock:f1|mock:s1",
  offer_key: "mock:f1",
  stay_key: "mock:s1",
  stay_index: 0,
  window: { check_in: "2026-12-06", check_out: "2026-12-08", nights: 2 },
  arrival_at: "2026-12-06T02:10:00+00:00",
  return_departure_at: "2026-12-08T10:00:00+00:00",
  flight_price: 176,
  flight_total: 176,
  stay_total: 231,
  costs: {
    items: [
      { kind: "tickets", amount: 176, status: "approximate", included: false },
      { kind: "baggage", amount: null, status: "unknown", included: false },
      { kind: "stay", amount: 231, status: "confirmed", included: false },
      { kind: "extra", label: "Музей", amount: 30, status: "approximate", included: false },
    ],
    confirmed: 231,
    approximate: 206,
    unknown: 1,
  },
  money_total: 437,
  value_total: 480.5,
  stops: 0,
  currency: "EUR",
  warnings: ["night_arrival", "costs_unknown"],
  full_nights: 2,
  converted_from: ["PLN"],
  travel_min: 610,
  waiting_min: 90,
  reasons: [
    { code: "best_value", count: 6 },
    { code: "pricier_but_faster", vs: "cheapest", amount: 40, minutes: 300 },
    { code: "more_full_nights", vs: "cheapest", count: 1 },
    { code: "over_budget", amount: 37 },
  ],
};

describe("TripCard", () => {
  it("загальна сума з розбивкою, рейс, житло і посилання на деталі", () => {
    render(
      <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
        <TripCard
          combo={COMBO}
          offer={OFFER}
          stay={STAY}
          travelers="2 дорослі"
          label="best_value"
          also={["cheapest"]}
          overBudget
          airlineNames={{ LO: "LOT Polish" }}
          flightsHref="/?from=WAW&to=LIS"
          staysHref="/stays?city=LIS"
        />
      </NextIntlClientProvider>,
    );

    expect(screen.getByText("Оптимальний")).toBeInTheDocument();
    // Модуль 18.2: переведене з іншої валюти — орієнтовне, без обіцянки суми списання.
    expect(screen.getByTestId("trip-converted")).toHaveTextContent(
      "Частину сум переведено з PLN за курсом ЄЦБ — орієнтовно",
    );
    // Модуль 14.4–14.5: повноцінні ночі, час у дорозі й конкретні причини.
    expect(screen.getByTestId("trip-quality")).toHaveTextContent(
      "2 з 2 ночей повноцінні · у дорозі 10 год 10 хв · з них очікування 1 год 30 хв",
    );
    const why = screen.getByTestId("trip-why-reasons");
    expect(why).toHaveTextContent(
      "Найкраще поєднання ціни, часу в дорозі й житла серед 6 комбінацій",
    );
    expect(why).toHaveTextContent("На 40 € дорожча за «Економ», але на 5 год менше в дорозі");
    expect(why).toHaveTextContent("На 1 повноцінну ніч більше, ніж в «Економі»");
    expect(why).toHaveTextContent("Перевищує бюджет на 37 €");
    expect(screen.getByText("також Економ")).toBeInTheDocument();
    expect(screen.getByTestId("trip-over-budget")).toBeInTheDocument();
    expect(screen.getByTestId("trip-total")).toHaveTextContent("437 €");
    expect(screen.getByText(/1 складова з невідомою сумою/)).toBeInTheDocument();
    const breakdown = screen.getByTestId("trip-breakdown");
    // Ціна перельоту вже за обох — без «2 × …» (ADR 0013); статус кожної складової.
    expect(breakdown).toHaveTextContent("КвиткиОрієнтовно176 €");
    expect(breakdown).toHaveTextContent("БагажНевідомоневідомо");
    expect(breakdown).toHaveTextContent("Житло, 2 ночіПідтверджено231 €");
    expect(breakdown).toHaveTextContent("МузейОрієнтовно30 €");
    expect(breakdown).toHaveTextContent("Підтверджено231 €Орієнтовно206 €Разом (відоме)437 €");
    // Нічний приліт 6-го — заїзд 6-го, а не в день вильоту.
    const dates = screen.getByTestId("trip-dates");
    expect(dates).toHaveTextContent("Приліт нд, 6 груд., 02:10 → заїзд нд, 6 груд.");
    expect(dates).toHaveTextContent("Виліт назад вт, 8 груд., 10:00 → виїзд вт, 8 груд.");
    expect(screen.getByText(/Приліт уночі/)).toBeInTheDocument();
    expect(screen.getByText("Pension Rosa")).toBeInTheDocument();
    // Модуль 23b: переліт і житло — окремі блоки, кожен зі своєю ціною, статусом і посиланням.
    const flight = screen.getByTestId("trip-flight");
    expect(flight).toHaveTextContent("Переліт");
    expect(within(flight).getByRole("link", { name: "Відкрити квиток" })).toHaveAttribute(
      "href",
      "/?from=WAW&to=LIS#offer-mock-f1",
    );
    const stay = screen.getByTestId("trip-stay");
    expect(stay).toHaveTextContent("Pension Rosa");
    expect(stay).toHaveTextContent("231 €Підтверджено");
    expect(within(stay).getByRole("link", { name: "Відкрити житло" })).toHaveAttribute(
      "href",
      "/stays?city=LIS#stay-mock-s1",
    );
  });
});
