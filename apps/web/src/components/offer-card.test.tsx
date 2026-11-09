import type { BaggageCost, Offer } from "@tickets/shared";
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
  price_status: "cached",
  found_on: null,
  seller: null,
  reported_total_duration_min: null,
  stops: 2,
  total_duration_min: 976,
};

function card(offer: Offer, baggageCost?: BaggageCost) {
  return (
    <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
      <OfferCard
        offer={offer}
        now={NOW}
        baggageCost={baggageCost}
        baggageNeed={baggageCost ? "carry_on" : "none"}
      />
    </NextIntlClientProvider>
  );
}

function renderCard(offer: Offer, baggageCost?: BaggageCost) {
  return render(card(offer, baggageCost));
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

  it("рейс у кількох продавців — найдешевший продавець і їх кількість (модуль 22.6)", () => {
    render(
      <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
        <OfferCard offer={{ ...base, seller: "Trip.com" }} now={NOW} sellerCount={3} />
      </NextIntlClientProvider>,
    );

    expect(screen.getByTestId("seller")).toHaveTextContent(
      "Найдешевше: Trip.com · 3 продавці · через Тестові дані",
    );
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

  it("умови багажу й ціна з обраним багажем; невідоме — не «безкоштовно»", () => {
    const fee = (amount: number) => ({ status: "fee" as const, fee: amount });
    const { rerender } = renderCard(
      {
        ...base,
        baggage: {
          personal_item: { status: "included", fee: null },
          carry_on: fee(25),
          checked: { status: "fee", fee: null },
          checked_extra: null,
        },
      },
      { status: "extra", extra: 25, total: 217, unknown: [] },
    );

    const bags = screen.getByTestId("baggage");
    // Лише ті місця, що обрав користувач (ручна поклажа = особиста річ + ручна).
    expect(bags).toHaveTextContent("Особиста річ: у тарифі");
    expect(bags).toHaveTextContent("Ручна поклажа: за плату · 25 €");
    expect(bags).not.toHaveTextContent("Зареєстрований");
    expect(screen.getByTestId("baggage-total")).toHaveTextContent("З багажем: 217 €");

    rerender(card(base, { status: "unknown", extra: null, total: null, unknown: ["checked"] }));
    expect(screen.getByTestId("baggage-total")).toHaveTextContent("уточніть у продавця");
  });

  it("позначки лише з реальних параметрів і кілька виборів скорингу", () => {
    renderCard(base); // 2 пересадки на окремих квитках
    const badges = screen.getByTestId("offer-badges");
    expect(badges).toHaveTextContent("Самостійна пересадка");
    expect(badges).not.toHaveTextContent("Прямий рейс");

    const direct: Offer = {
      ...base,
      outbound: { ...base.outbound, stops: 0, layovers: [] },
      stops: 0,
    };
    render(
      <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
        <OfferCard
          offer={direct}
          now={NOW}
          pickLabel="cheapest"
          pickAlso={["fastest", "balanced"]}
        />
      </NextIntlClientProvider>,
    );
    const [, second] = screen.getAllByTestId("offer-badges");
    expect(second).toHaveTextContent("НайдешевшийНайшвидшийОптимальнийПрямий рейс");
    expect(second).not.toHaveTextContent("Самостійна");
  });

  it("деталі маршруту: сегменти, очікування, зміна аеропорту, повторна реєстрація багажу", () => {
    const seg = (o: string, d: string, dep: string, arr: string, n: string) => ({
      origin: o,
      destination: d,
      departure_at: dep,
      arrival_at: arr,
      carrier: "FR",
      flight_number: n,
      duration_min: 120,
    });
    renderCard({
      ...base,
      outbound: {
        ...base.outbound,
        stops: 1,
        segments: [
          seg("WAW", "STN", "2026-11-10T06:00:00+01:00", "2026-11-10T07:30:00+00:00", "FR1"),
          seg("LTN", "LIS", "2026-11-10T12:00:00+00:00", "2026-11-10T14:40:00+00:00", "W62"),
        ],
        layovers: [{ airport: "STN", duration_min: 270, overnight: false, self_transfer: true }],
      },
      stops: 1,
    });

    const details = screen.getByTestId("route-details");
    expect(within(details).getAllByTestId("segment")).toHaveLength(2);
    expect(details).toHaveTextContent("WAW 06:00 · 10 лист. → STN 07:30 · 10 лист.");
    const connection = within(details).getByTestId("connection");
    expect(connection).toHaveTextContent("Пересадка в STN: очікування 4 год 30 хв");
    expect(connection).toHaveTextContent("Зміна аеропорту: STN → LTN");
    expect(connection).toHaveTextContent("багаж треба отримати й зареєструвати знову");
  });

  it("без посегментних даних — чесно «джерело не дає»", () => {
    renderCard(base);
    expect(screen.getByTestId("route-details")).toHaveTextContent(
      "Посегментних даних джерело не дає",
    );
  });
});
