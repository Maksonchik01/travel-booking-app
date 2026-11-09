import type {
  AlertCreate,
  AlertCreated,
  ChannelStatus,
  FlightQuery,
  StayQuery,
} from "@tickets/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../messages/uk.json";
import { flightTarget, stayTarget } from "@/lib/alerts";

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

const CHANNELS = {
  telegram: "live",
  email: "mock",
  bot_username: "flyandbookbot",
  kinds: ["flight", "flex"],
  max_active_per_owner: 20,
} as const satisfies ChannelStatus;

function renderAlert(create: (body: AlertCreate) => Promise<AlertCreated | null>) {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages}>
      <PriceAlert
        target={flightTarget(QUERY)!}
        bestPrice={88.5}
        channels={CHANNELS}
        create={create}
      />
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
      existing: false,
    }));
    const view = renderAlert(create);

    fireEvent.click(screen.getByRole("button", { name: "Стежити за ціною" }));
    expect(screen.getByLabelText("Поріг ціни, EUR")).toHaveValue(79); // −10% від 88,5, вниз
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Підписатися" }));
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "flight",
        origin: "WAW",
        destination: "LIS",
        return_date: "2026-12-12",
        baggage: "none",
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

  it("гнучкі дати: вихідні й зниження на відсоток; багаж — чесна примітка", async () => {
    const create = vi.fn(async () => null);
    const flex: FlightQuery = {
      ...QUERY,
      departure_date: "2026-12-01",
      departure_until: "2026-12-31",
      return_date: "2026-12-02",
      min_nights: 1,
      max_nights: 3,
      baggage: "carry_on",
    };
    render(
      <NextIntlClientProvider locale="uk" messages={messages}>
        <PriceAlert
          target={flightTarget(flex)!}
          bestPrice={120}
          channels={CHANNELS}
          create={create}
        />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Стежити за ціною" }));
    expect(
      screen.getByText(/Гнучкі дати: виліт 2026-12-01 – 2026-12-31, 1–3 ноч\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/ціна без багажу/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/нижча за типову/)).toBeNull(); // лише для точних дат
    fireEvent.click(screen.getByLabelText(/Лише вихідні/));
    // Умови: поріг, зниження на суму, на відсоток (третя).
    fireEvent.click(screen.getAllByRole("radio", { name: /Ціна/ })[2]);
    fireEvent.change(screen.getByLabelText("Відсоток зниження"), { target: { value: "15" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Підписатися" }));
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "flex",
        departure_until: "2026-12-31",
        min_nights: 1,
        max_nights: 3,
        weekends: true,
        baggage: "carry_on",
        condition: "drop_percent",
        percent: 15,
        threshold: null,
      }),
    );
  });

  it("житло без реального джерела й діти — неактивно з поясненням", () => {
    expect(
      flightTarget({ ...QUERY, passengers: { ...QUERY.passengers!, children: 1 } }),
    ).toBeNull();
    render(
      <NextIntlClientProvider locale="uk" messages={messages}>
        <PriceAlert
          target={stayTarget({
            city: "LIS",
            check_in: "2026-12-05",
            check_out: "2026-12-08",
          } as StayQuery)}
          bestPrice={300}
          channels={CHANNELS}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole("button", { name: "Стежити за ціною" })).toBeDisabled();
    expect(screen.getByTestId("alert-unavailable")).toHaveTextContent(
      "реальне джерело цін на житло",
    );
  });
});

describe("PriceAlert — така сама підписка вже є", () => {
  it("каже, що вже стежите, і не просить підтверджувати знову", async () => {
    const create = vi.fn(async () => ({
      id: "a1",
      status: "active",
      channel: "telegram" as const,
      manage_token: "tok-existing-1234567890",
      telegram_link: null,
      existing: true,
    }));
    renderAlert(create);

    fireEvent.click(screen.getByRole("button", { name: "Стежити за ціною" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Підписатися" }));
    });

    expect(screen.getByText("Така підписка у вас уже є — нову не створюємо.")).toBeInTheDocument();
    expect(screen.queryByText(/Відкрити @/)).not.toBeInTheDocument();
  });
});
