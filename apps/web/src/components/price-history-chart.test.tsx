import type { FlightQuery, PriceSeries, StayQuery } from "@tickets/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import messages from "../../messages/uk.json";
import { flightTarget, stayTarget } from "@/lib/alerts";

import { PriceHistoryChart } from "./price-history-chart";

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>,
  );
}

const SERIES: PriceSeries = {
  currency: "EUR",
  enough: true,
  points: [
    { day: "2026-11-05", price: 210, observations: 3 },
    { day: "2026-11-07", price: 190, observations: 1 },
    { day: "2026-11-10", price: 175, observations: 2 },
  ],
};

describe("історія цін (етап 6)", () => {
  it("графік: діапазон, зміна від першого дня, підказка й таблиця тих самих даних", () => {
    wrap(<PriceHistoryChart series={SERIES} title="Історія цін на ці дати" />);

    const chart = screen.getByTestId("price-history");
    expect(chart).toHaveTextContent("від 175 € до 210 € · 3 дні спостережень");
    expect(chart).toHaveTextContent("дешевше на 35 €, ніж спочатку");
    fireEvent.focus(screen.getByRole("button", { name: /10 лист.*175/ }));
    expect(screen.getByRole("status")).toHaveTextContent("175 €");
    expect(screen.getAllByRole("row")).toHaveLength(4); // заголовок + 3 дні
  });

  it("менше трьох днів — без графіка, чесно «даних ще мало»", () => {
    wrap(
      <PriceHistoryChart
        series={{ ...SERIES, enough: false, points: SERIES.points.slice(0, 2) }}
        title="Історія"
      />,
    );
    expect(screen.getByTestId("price-history-few")).toHaveTextContent("Історії ще мало: 2 дні");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("сповіщення беруть умови з пошуку: прямі рейси, рейтинг житла", () => {
    const flight = flightTarget({
      origin: "WAW",
      destination: "LIS",
      departure_date: "2026-12-05",
      return_date: "2026-12-08",
      direct_only: true,
      currency: "EUR",
    } as FlightQuery)!;
    expect(flight.base.direct_only).toBe(true);
    expect(flight.key).toContain("direct");

    const stay = stayTarget({
      city: "LIS",
      check_in: "2026-12-05",
      check_out: "2026-12-08",
      filters: { min_rating: 8 },
    } as StayQuery);
    expect(stay.base.min_rating).toBe(8);
  });
});
