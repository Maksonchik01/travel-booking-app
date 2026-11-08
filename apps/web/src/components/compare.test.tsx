import type { Offer } from "@tickets/shared";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import messages from "../../messages/uk.json";
import { CompareBar, CompareProvider, CompareToggle } from "./compare";

function offer(id: string, price: number, over: Partial<Offer> = {}): Offer {
  return {
    id,
    source: "serpapi",
    price,
    currency: "EUR",
    outbound: {
      origin: "WAW",
      destination: "LIS",
      departure_at: "2026-12-05T06:20:00+01:00",
      arrival_at: "2026-12-05T10:05:00+00:00",
      stops: 0,
    },
    inbound: null,
    airlines: ["LO"],
    details_level: "full",
    collected_at: "2026-11-08T11:00:00Z",
    price_status: "live",
    cabin: "economy",
    stops: 0,
    total_duration_min: 285,
    ...over,
  } as Offer;
}

const OFFERS = [
  offer("a", 120),
  offer("b", 99, {
    total_duration_min: 400,
    baggage_included: true,
    airlines: ["W6"],
    price_status: "cached",
  }),
  offer("c", 150),
  offer("d", 130),
];

beforeAll(() => {
  // jsdom не має showModal у <dialog>.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

beforeEach(() => sessionStorage.clear());

function wrap() {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
      <CompareProvider>
        {OFFERS.map((o) => (
          <div key={o.id} data-testid={`card-${o.id}`}>
            <CompareToggle offer={o} />
          </div>
        ))}
        <CompareBar airlineNames={{ LO: "LOT", W6: "Wizz Air" }} />
      </CompareProvider>
    </NextIntlClientProvider>,
  );
}

const toggle = (id: string) =>
  within(screen.getByTestId(`card-${id}`)).getByTestId("compare-toggle");

describe("Порівняння варіантів", () => {
  it("до трьох; таблиця з ціною, тривалістю, багажем, авіакомпанією й умовами; видалення", () => {
    wrap();
    fireEvent.click(toggle("a"));
    const bar = () => screen.getByTestId("compare-bar");
    // Один варіант — нема з чим порівнювати.
    expect(within(bar()).getByRole("button", { name: "Порівняти" })).toBeDisabled();
    fireEvent.click(toggle("b"));
    fireEvent.click(toggle("c"));
    expect(toggle("d")).toBeDisabled();
    expect(screen.getByTestId("compare-bar")).toHaveTextContent("Обрано для порівняння: 3 з 3");
    expect(JSON.parse(sessionStorage.getItem("tickets.compare.v1") ?? "[]")).toHaveLength(3);

    fireEvent.click(
      within(screen.getByTestId("compare-bar")).getByRole("button", { name: "Порівняти" }),
    );
    const table = screen.getByTestId("compare-table");
    expect(table).toHaveTextContent("Wizz Air");
    expect(table).toHaveTextContent("Багаж включено");
    expect(table).toHaveTextContent("Економ · жива ціна");
    expect(table).toHaveTextContent("кешована ціна");

    fireEvent.click(within(table).getAllByRole("button", { name: "Прибрати з порівняння" })[0]);
    expect(screen.getByTestId("compare-bar")).toHaveTextContent("2 з 3");
    expect(toggle("d")).not.toBeDisabled();
  });
});
