import type { Offer } from "@tickets/shared";
import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import messages from "../../messages/uk.json";
import { OfferCard } from "./offer-card";

const NOW = new Date("2026-10-26T12:00:00Z");

const base: Offer = {
  id: "1",
  source: "mock",
  price: 192,
  currency: "EUR",
  outbound: {
    origin: "WAW",
    destination: "LIS",
    departure_at: "2026-11-10T21:20:00Z",
    arrival_at: "2026-11-11T13:36:00Z",
    duration_min: 976,
    stops: 2,
    segments: null,
    layovers: [
      { airport: "ZRH", duration_min: 40, overnight: false, self_transfer: true },
      { airport: "CDG", duration_min: 300, overnight: true, self_transfer: true },
    ],
    flight_number: null,
  },
  inbound: null,
  airlines: ["FR", "U2"],
  airline_logos: { FR: "https://www.gstatic.com/flights/airline_logos/70px/FR.png" },
  details_level: "full",
  baggage_included: false,
  collected_at: "2026-10-26T11:00:00Z",
  found_at: "2026-10-26T07:00:00Z",
  expires_at: null,
  deep_link: null,
  found_on: null,
  seller: null,
  reported_total_duration_min: null,
  stops: 2,
  total_duration_min: 976,
};

function renderCard(offer: Offer) {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
      <OfferCard offer={offer} now={NOW} />
    </NextIntlClientProvider>,
  );
}

describe("OfferCard", () => {
  it("показує ціну, вік ціни та час у поясі аеропорту", () => {
    renderCard(base);

    expect(screen.getByTestId("price")).toHaveTextContent("192 €");
    expect(screen.getByTestId("price-age")).toHaveTextContent("ціну знайдено 5 год тому");
    expect(screen.getByText("21:20")).toBeInTheDocument();
    expect(screen.getByText("16 год 16 хв")).toBeInTheDocument();
    expect(screen.getByText("2 пересадки")).toBeInTheDocument();
    expect(screen.getByText("Без багажу")).toBeInTheDocument();
  });

  it("логотип авіакомпанії біля відрізка, без логотипа — код у кружечку", () => {
    renderCard(base);

    const [outbound] = screen.getAllByTestId("airlines");
    expect(outbound).toHaveTextContent("FR · U2");
    const logo = within(outbound!).getByTestId("airline-logo");
    // next/image віддає картинку через свій оптимізатор, а не з хоста провайдера.
    expect(logo.getAttribute("src")).toMatch(
      /^\/_next\/image\?url=https%3A%2F%2Fwww\.gstatic\.com/,
    );
    expect(within(outbound!).getByTestId("airline-monogram")).toHaveTextContent("U2");
    expect(screen.getByTestId("seller")).toHaveTextContent("через Тестові дані");
  });

  it("позначає ризики кожної пересадки", () => {
    renderCard(base);

    const [zrh, cdg] = screen.getAllByTestId("layover");
    expect(within(zrh!).getByText("коротка")).toBeInTheDocument();
    expect(within(zrh!).getByText("окремі квитки")).toBeInTheDocument();
    expect(within(cdg!).getByText("нічна")).toBeInTheDocument();
  });

  it("для Travelpayouts показує день знаходження ціни та продавця", () => {
    renderCard({ ...base, found_at: null, found_on: "2026-10-23", seller: "Kiwi.com" });

    expect(screen.getByTestId("price-age")).toHaveTextContent("ціну знайдено 3 дні тому");
    expect(screen.getByTestId("seller")).toHaveTextContent("Продавець: Kiwi.com");
  });

  it("для кешованого джерела без деталей пише, що деталі невідомі", () => {
    renderCard({
      ...base,
      details_level: "summary",
      found_at: null,
      baggage_included: null,
      deep_link: "https://www.aviasales.com/search/x",
      outbound: { ...base.outbound, layovers: null, arrival_at: null },
    });

    expect(screen.getByText("Деталі пересадок невідомі")).toBeInTheDocument();
    expect(screen.getByTestId("price-age")).toHaveTextContent("час знаходження невідомий");
    expect(screen.getByText("Умови багажу невідомі")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /До продавця/ });
    expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
    expect(link).toHaveAttribute(
      "href",
      `/out?url=${encodeURIComponent("https://www.aviasales.com/search/x")}&kind=flight&source=${base.source}`,
    );
    expect(screen.getByText(/на сайті партнера/)).toBeInTheDocument();
  });
});
