import type { CalendarDay, MatrixCell } from "@tickets/shared";
import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import messages from "../../messages/uk.json";
import { parseSearchParams } from "../lib/search-params";
import { PriceCalendar } from "./price-calendar";
import { PriceMatrix } from "./price-matrix";

const NOW = new Date("2026-11-08T12:00:00Z");
const oneWay = parseSearchParams({ from: "WAW", to: "BCN", depart: "2026-12-05" })!;
const roundTrip = parseSearchParams({
  from: "WAW",
  to: "LIS",
  depart: "2026-12-05",
  return: "2026-12-12",
})!;

function day(date: string, price: number, over: Partial<CalendarDay> = {}): CalendarDay {
  return {
    date,
    price,
    currency: "EUR",
    stops: 0,
    airline: null,
    source: "travelpayouts",
    collected_at: "2026-11-08T12:00:00Z",
    found_at: null,
    found_on: "2026-11-06",
    ...over,
  };
}

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("PriceCalendar", () => {
  const days = [
    day("2026-12-03", 60),
    day("2026-12-04", 45),
    day("2026-12-05", 58),
    day("2026-12-06", 90),
    day("2026-12-07", 52),
  ];

  it("найдешевші дні, різниця з обраним днем, вік ціни й позначка живої перевірки", () => {
    wrap(
      <PriceCalendar
        month="2026-12"
        days={days}
        state={oneWay}
        now={NOW}
        verified={{ "2026-12-05": 61 }}
      />,
    );

    const cells = screen.getAllByTestId("calendar-day");
    const byDay = (d: number) =>
      cells.find((c) => c.getAttribute("href")?.includes(`2026-12-0${d}`))!;
    expect(cells.filter((c) => c.dataset.cheap === "true")).toHaveLength(3);
    expect(within(byDay(4)).getByTestId("calendar-diff")).toHaveTextContent("−13");
    expect(within(byDay(6)).getByTestId("calendar-diff")).toHaveTextContent("+32");
    expect(byDay(4)).toHaveAttribute("title", expect.stringContaining("знайдено 2 дні тому"));
    expect(byDay(5)).toHaveAttribute("title", expect.stringContaining("наживо зараз: 61"));
    expect(screen.getByLabelText("перевірено наживо")).toBeInTheDocument();
  });

  it("місяці гортаються без зміни пошуку; у минуле — ні", () => {
    wrap(<PriceCalendar month="2026-11" days={[]} state={oneWay} now={NOW} />);

    expect(screen.queryByRole("link", { name: "Попередній місяць" })).toBeNull();
    expect(screen.getByRole("link", { name: "Наступний місяць" })).toHaveAttribute(
      "href",
      "/?from=WAW&to=BCN&depart=2026-12-05&cal=2026-12#calendar",
    );
    expect(screen.getByText("На цей місяць кешованих цін ще немає.")).toBeInTheDocument();
  });
});

describe("PriceMatrix", () => {
  function cell(dep: string, ret: string, price: number): MatrixCell {
    return {
      departure: dep,
      return_date: ret,
      price,
      currency: "EUR",
      stops: 0,
      source: "travelpayouts",
      found_at: null,
      found_on: "2026-11-06",
    };
  }

  it("виліт × повернення, найдешевша клітинка й посилання на точні дати", () => {
    wrap(
      <PriceMatrix
        state={roundTrip}
        matrix={{
          departures: ["2026-12-04", "2026-12-05"],
          returns: ["2026-12-11", "2026-12-12"],
          cells: [cell("2026-12-04", "2026-12-11", 140), cell("2026-12-05", "2026-12-12", 170)],
          providers: [],
        }}
      />,
    );

    const table = screen.getByTestId("matrix");
    expect(within(table).getAllByRole("columnheader")).toHaveLength(3);
    const cells = within(table).getAllByTestId("matrix-cell");
    expect(cells[0]).toHaveAttribute(
      "href",
      "/?from=WAW&to=LIS&depart=2026-12-04&return=2026-12-11",
    );
    expect(cells[0].className).toContain("emerald");
    expect(cells[1].className).toContain("bg-primary"); // поточні дати пошуку
    // Мобільний формат — список найдешевших комбінацій.
    expect(within(screen.getByTestId("matrix-list")).getAllByRole("link")).toHaveLength(2);
  });
});
