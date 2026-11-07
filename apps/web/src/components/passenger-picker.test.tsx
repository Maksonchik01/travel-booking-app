import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import messages from "../../messages/uk.json";
import { PassengerPicker, passengerLimits } from "./passenger-picker";

function renderPicker() {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
      <form aria-label="search">
        <PassengerPicker passengers={{ adults: 2, children: 0, infants: 1, infants_in_seat: 0 }} />
      </form>
    </NextIntlClientProvider>,
  );
}

describe("PassengerPicker", () => {
  it("межі як в API: до 9, на руках ≤ дорослих, ≤ 2 немовлят на дорослого", () => {
    expect(passengerLimits({ adults: 1, children: 0, lap: 1, seat: 0 })).toEqual({
      adults: 8,
      children: 7,
      lap: 1,
      seat: 1,
    });
    expect(passengerLimits({ adults: 4, children: 5, lap: 0, seat: 0 }).seat).toBe(0);
  });

  it("підсумок і поля форми; менше дорослих — менше немовлят на руках", () => {
    renderPicker();
    expect(screen.getByText(/3 пасажири · Економ/)).toBeInTheDocument();

    const form = screen.getByRole("form", { name: "search" }) as HTMLFormElement;
    const adults = form.elements.namedItem("adults") as HTMLSelectElement;
    fireEvent.change(adults, { target: { value: "1" } });
    fireEvent.change(form.elements.namedItem("lap") as HTMLSelectElement, {
      target: { value: "1" },
    });
    fireEvent.change(form.elements.namedItem("cabin") as HTMLSelectElement, {
      target: { value: "business" },
    });

    const data = Object.fromEntries(new FormData(form));
    expect(data).toEqual({
      adults: "1",
      children: "0",
      lap: "1",
      seat: "0",
      cabin: "business",
      bag: "none",
      cur: "EUR",
    });
    expect(screen.getByText(/2 пасажири · Бізнес/)).toBeInTheDocument();
  });
});
