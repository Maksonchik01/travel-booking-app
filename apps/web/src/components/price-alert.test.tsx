import type { AlertCreate, AlertCreated, FlightQuery } from "@tickets/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../messages/uk.json";
import { PriceAlert } from "./price-alert";

const QUERY: FlightQuery = {
  origin: "WAW",
  destination: "LIS",
  departure_date: "2026-12-05",
  return_date: "2026-12-12",
  flex_days: 0,
  passengers: { adults: 2, children: 0, infants: 0, infants_in_seat: 0 },
  cabin: "economy",
  baggage: "none",
  direct_only: false,
  currency: "EUR",
  profile: "balanced",
  origin_radius_km: 0,
  destination_radius_km: 0,
  filters: {},
};

const CHANNELS = { telegram: "live", email: "mock", bot_username: "flyandbookbot" } as const;

function renderAlert(create: (body: AlertCreate) => Promise<AlertCreated | null>) {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages}>
      <PriceAlert query={QUERY} bestPrice={88.5} channels={CHANNELS} create={create} />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => localStorage.clear());

describe("PriceAlert", () => {
  it("поріг від найкращої ціни; Telegram — посилання на бота; маршрут позначено як «стежите»", async () => {
    const create = vi.fn(async () => ({
      id: "a1",
      status: "pending",
      channel: "telegram" as const,
      manage_token: "tok-1234567890abcdef",
      telegram_link: "https://t.me/flyandbookbot?start=tok-1234567890abcdef",
    }));
    const view = renderAlert(create);

    fireEvent.click(screen.getByRole("button", { name: "Стежити за ціною" }));
    expect(screen.getByLabelText("Поріг ціни, EUR")).toHaveValue(79); // −10% від 88,5, вниз
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Підписатися" }));
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "WAW",
        destination: "LIS",
        return_date: "2026-12-12",
        adults: 2,
        condition: "below_price",
        threshold: 79,
        channel: "telegram",
        email: null,
      }),
    );
    expect(screen.getByRole("link", { name: /Відкрити @flyandbookbot/ })).toHaveAttribute(
      "href",
      "https://t.me/flyandbookbot?start=tok-1234567890abcdef",
    );

    view.unmount();
    renderAlert(create);
    expect(
      screen.getByRole("link", { name: "Ви стежите за цим маршрутом · Керувати" }),
    ).toHaveAttribute("href", "/alerts?token=tok-1234567890abcdef");
  });

  it("email і «нижче типової»: без порогу, з адресою; помилка — повідомлення", async () => {
    const create = vi.fn(async () => null);
    renderAlert(create);
    fireEvent.click(screen.getByRole("button", { name: "Стежити за ціною" }));

    fireEvent.click(screen.getByLabelText(/нижча за типову/));
    fireEvent.click(screen.getByLabelText(/Email/));
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: " me@example.com " },
    });
    expect(screen.getByText("(тестовий режим)")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Підписатися" }));
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        condition: "below_typical",
        threshold: null,
        channel: "email",
        email: "me@example.com",
      }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Не вдалося створити підписку");
  });
});
