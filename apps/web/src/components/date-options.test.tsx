import type { DateOption } from "@tickets/shared";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import messages from "../../messages/uk.json";
import { parseSearchParams } from "../lib/search-params";
import { DateOptions } from "./date-options";

const NOW = new Date("2026-11-08T12:00:00Z");
const state = parseSearchParams({
  from: "WAW",
  to: "LIS",
  depart: "2026-12-05",
  return: "2026-12-12",
  flex: "3",
})!;

function option(over: Partial<DateOption>): DateOption {
  return {
    departure: "2026-12-05",
    return_date: "2026-12-12",
    price: 100,
    currency: "EUR",
    verified: false,
    found_at: null,
    found_on: null,
    offers: 1,
    nights: null,
    nights_approximate: false,
    ...over,
  };
}

describe("DateOptions", () => {
  it("перевірені й кешовані з віком; посилання — пошук на точні дати", () => {
    render(
      <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
        <DateOptions
          state={state}
          now={NOW}
          options={[
            option({
              departure: "2026-12-06",
              return_date: "2026-12-13",
              price: 80,
              verified: true,
            }),
            option({
              departure: "2026-12-04",
              return_date: "2026-12-11",
              price: 90,
              found_on: "2026-11-06",
            }),
          ]}
        />
      </NextIntlClientProvider>,
    );

    const [first, second] = screen.getAllByTestId("date-option");
    expect(first).toHaveTextContent("перевірено наживо");
    expect(first).toHaveAttribute("href", "/?from=WAW&to=LIS&depart=2026-12-06&return=2026-12-13");
    expect(second).toHaveTextContent("кешована · 2 дні тому");
  });

  it("одна пара дат — блоку немає", () => {
    const { container } = render(
      <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
        <DateOptions state={state} now={NOW} options={[option({})]} />
      </NextIntlClientProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
