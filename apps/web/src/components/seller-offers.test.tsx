import type { FlightQuery, Offer, SellersResult } from "@tickets/shared";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../messages/uk.json";
import { SellerOffers } from "./seller-offers";

const NOW = "2026-11-08T12:00:00Z";
const query = {
  origin: "WAW",
  destination: "BCN",
  departure_date: "2026-12-13",
} as FlightQuery;

function offer(over: Partial<Offer>): Offer {
  return {
    id: "1",
    source: "serpapi",
    price: 121,
    currency: "EUR",
    outbound: {
      origin: "WAW",
      destination: "BCN",
      departure_at: "2026-12-13T06:20:00+01:00",
      stops: 0,
      flight_number: "LO437",
    },
    inbound: null,
    airlines: ["LO"],
    details_level: "full",
    collected_at: "2026-11-08T11:00:00Z",
    price_status: "live",
    stops: 0,
    total_duration_min: 190,
    ...over,
  } as Offer;
}

function wrap(rows: Offer[]) {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
      <SellerOffers offer={rows[0]} rows={rows} query={query} now={NOW} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("SellerOffers", () => {
  it("той самий рейс з двох джерел: умови кожного, підтверджена найдешевша виділена", () => {
    wrap([
      offer({
        id: "tp",
        source: "travelpayouts",
        price: 115,
        price_status: "cached",
        seller: "Kiwi.com",
        deep_link: "https://www.aviasales.com/search/x",
      }),
      offer({ baggage_included: null }),
    ]);

    const rows = screen.getAllByTestId("seller-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Kiwi.com");
    expect(rows[0]).toHaveTextContent("кешована ціна, орієнтовна");
    expect(rows[0].className).not.toContain("success"); // дешевша, але не підтверджена
    expect(rows[1].className).toContain("success");
    expect(within(rows[0]).getByRole("link", { name: /Переглянути пропозицію/ })).toHaveAttribute(
      "href",
      expect.stringMatching(/^\/out\?url=/),
    );
  });

  it("перевірка продавців: нова ціна, POST-перехід через Google", async () => {
    const result: SellersResult = {
      status: "ok",
      checked_at: "2026-11-08T12:00:00Z",
      sellers: [
        {
          seller: "LOT",
          is_airline: true,
          price: 123,
          currency: "EUR",
          included: ["1 free carry-on"],
          fare_name: null,
          link: {
            url: "https://www.google.com/travel/clk/f",
            method: "POST",
            post_data: "u=abc&x=1",
          },
          checked_at: "2026-11-08T12:00:00Z",
        },
        {
          seller: "Gotogate",
          is_airline: false,
          price: 143,
          currency: "EUR",
          included: [],
          fare_name: null,
          link: null,
          checked_at: "2026-11-08T12:00:00Z",
        },
      ],
    };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(result)));
    vi.stubGlobal("fetch", fetchMock);
    wrap([offer({ booking_ref: "tok" })]);

    fireEvent.click(screen.getByRole("button", { name: "Порівняти продавців і перевірити ціну" }));

    expect(
      await screen.findByText("Ціна змінилась: у пошуку 121 €, зараз від 123 €."),
    ).toBeInTheDocument();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      source: "serpapi",
      booking_ref: "tok",
    });
    const [lot, gotogate] = screen.getAllByTestId("checked-seller");
    expect(lot).toHaveTextContent("LOTавіакомпанія");
    expect(lot).toHaveTextContent("1 free carry-on");
    expect(gotogate).toHaveTextContent("що входить у тариф — на сайті продавця");
    const form = lot.querySelector("form")!;
    expect(form).toHaveAttribute("action", "https://www.google.com/travel/clk/f");
    expect(form).toHaveAttribute("method", "post");
    expect(form.querySelector<HTMLInputElement>("input[name=u]")?.value).toBe("abc");
  });

  it("autoCheck: найкращий рейс порівнює продавців сам, один раз (модуль 22.9)", async () => {
    const result: SellersResult = {
      status: "ok",
      checked_at: "2026-11-08T12:00:00Z",
      sellers: [
        {
          seller: "KLM",
          is_airline: true,
          price: 121,
          currency: "EUR",
          included: [],
          fare_name: null,
          link: null,
          checked_at: "2026-11-08T12:00:00Z",
        },
      ],
    };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(result)));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
        <SellerOffers
          offer={offer({ booking_ref: "tok" })}
          rows={[offer({ booking_ref: "tok" })]}
          query={query}
          now={NOW}
          autoCheck
        />
      </NextIntlClientProvider>,
    );

    expect(await screen.findByTestId("checked-seller")).toHaveTextContent("KLM");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("autoCheck не вдався — лишається кнопка, без помилки, якої не просили", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ status: "rate_limited", sellers: [] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
        <SellerOffers
          offer={offer({ booking_ref: "tok" })}
          rows={[offer({ booking_ref: "tok" })]}
          query={query}
          now={NOW}
          autoCheck
        />
      </NextIntlClientProvider>,
    );

    expect(
      await screen.findByRole("button", { name: "Порівняти продавців і перевірити ціну" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("джерело без перевірки — чесно: підтверджує продавець; один продавець без імітації порівняння", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ status: "unsupported", sellers: [] }))),
    );
    wrap([offer({ booking_ref: "tok" })]);
    fireEvent.click(screen.getByRole("button", { name: /Порівняти продавців/ }));
    expect(await screen.findByText(/остаточну вартість підтверджує продавець/)).toBeInTheDocument();

    const { container } = render(
      <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
        <SellerOffers offer={offer({})} rows={[offer({})]} query={query} now={NOW} />
      </NextIntlClientProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
