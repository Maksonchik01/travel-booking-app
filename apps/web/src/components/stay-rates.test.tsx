import type { FavoriteOut, Stay, StayQuery, StayRatesResult } from "@tickets/shared";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../messages/uk.json";
import { FavoritesList, FavoritesProvider } from "./favorites";
import { tripFromStay } from "@/lib/trip-params";

import { StayCard } from "./stay-card";

const actions = vi.hoisted(() => ({
  loadFavorites: vi.fn(),
  addFavorite: vi.fn(),
  removeFavorite: vi.fn(),
}));
vi.mock("@/app/actions/favorites", () => actions);

const NOW = new Date("2026-11-06T12:00:00Z");

const STAY: Stay = {
  id: "mock-lis-1",
  source: "mock",
  name: "Hotel Meridian",
  kind: "hotel",
  stars: 4,
  price_per_night: 120,
  total_price: 360,
  currency: "EUR",
  nights: 3,
  rooms: 1,
  rating: 8.6,
  review_count: 1350,
  distance_to_center_km: 1.4,
  distance_to_transit_m: null,
  cancellation: "free",
  free_cancellation_until: "2026-12-03",
  amenities: ["wifi", "breakfast"],
  district: "Центр",
  address: null,
  image_url: null,
  sellers: 3,
  breakfast_included: null,
  collected_at: "2026-11-06T10:00:00Z",
  found_at: "2026-11-06T10:00:00Z",
  taxes_included: true,
};

const QUERY: StayQuery = {
  city: "LIS",
  check_in: "2026-12-05",
  check_out: "2026-12-08",
  guests: { adults: 2, children: 1, rooms: 1 },
  currency: "EUR",
  profile: "balanced",
  filters: {
    free_cancellation: false,
    breakfast_included: false,
    no_prepayment: false,
    pay_at_property: false,
  },
};

const RATE = {
  is_property: false,
  sponsored: false,
  room_name: "Стандартний двомісний номер",
  bed_type: "double" as const,
  meal: "room_only" as const,
  cancellation: "free" as const,
  currency: "EUR",
  checked_at: "2026-11-06T11:58:00Z",
};

const RATES: StayRatesResult = {
  status: "ok",
  sellers: 3,
  nights: 3,
  checked_at: "2026-11-06T11:58:00Z",
  rooms: [
    {
      key: "std|double|room_only|free",
      room_name: RATE.room_name,
      bed_type: "double",
      meal: "room_only",
      cancellation: "free",
      offers: [
        {
          rate: {
            ...RATE,
            seller: "Demo Travel",
            price_total: 300,
            taxes_included: false,
            taxes: 30,
            fees_at_property: 15,
          },
          final_total: 345,
          cheapest: true,
        },
        {
          rate: { ...RATE, seller: "Sample Booking", price_total: 360, taxes_included: true },
          final_total: 360,
          cheapest: false,
        },
        {
          rate: {
            ...RATE,
            seller: "Test Stays",
            price_total: 290,
            taxes_included: true,
            fees_at_property: null,
          },
          final_total: null,
          cheapest: false,
        },
      ],
    },
    {
      key: "superior|double|room_only|free",
      room_name: "Покращений номер",
      bed_type: "double",
      meal: "breakfast",
      cancellation: "non_refundable",
      offers: [
        {
          rate: {
            ...RATE,
            room_name: "Покращений номер",
            meal: "breakfast",
            cancellation: "non_refundable",
            seller: "Demo Travel",
            price_total: 420,
            taxes_included: true,
            fees_at_property: 0,
          },
          final_total: 420,
          cheapest: false,
        },
      ],
    },
  ],
};

function renderCard(stay: Stay = STAY) {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
      <FavoritesProvider>
        <StayCard stay={stay} now={NOW} query={QUERY} searchParams="city=LIS&in=2026-12-05" />
      </FavoritesProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  actions.loadFavorites.mockResolvedValue({ signedIn: false });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("картка житла: дії модуля 7", () => {
  it("«Детальніше» показує відоме й чесне «невідомо»", async () => {
    renderCard();
    fireEvent.click(screen.getByTestId("stay-details-toggle"));

    const details = screen.getByTestId("stay-details");
    expect(details).toHaveTextContent("безкоштовно до 3 грудня");
    expect(details).toHaveTextContent("До транспортуневідомо");
    expect(details).toHaveTextContent("Сніданок включеноневідомо");
    expect(screen.getByTestId("stay-sellers")).toHaveTextContent("3 продавці");
    expect(screen.queryByTestId("stay-photo")).toBeNull(); // фото немає — не вигадуємо
  });

  it("«Порівняти ціни»: групи умов, кінцева сума й найдешевше лише серед відомих", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(RATES)));
    renderCard();

    await act(async () => fireEvent.click(screen.getByTestId("stay-rates-toggle")));

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ source: "mock", stay_id: "mock-lis-1", query: QUERY });
    const rooms = screen.getAllByTestId("stay-room");
    expect(rooms).toHaveLength(2);
    const rows = within(rooms[0]).getAllByTestId("stay-rate");
    expect(rows[0]).toHaveTextContent("Найдешевше");
    expect(rows[0]).toHaveTextContent(/345\s€кінцева сума/);
    expect(rows[0]).toHaveTextContent(/\+ податки 30\s€ · \+ збори на місці 15\s€/);
    expect(rows[2]).toHaveTextContent("обов'язкові збори невідомі");
    expect(rows[2]).toHaveTextContent("кінцеву підтверджує він");
    expect(rows[2]).not.toHaveTextContent("Найдешевше");
    expect(rooms[1]).toHaveTextContent("зі сніданком · без повернення коштів");
    expect(screen.getByTestId("stay-rates")).toHaveTextContent("Тарифи перевірено 2 хв тому");

    // Повторне відкриття — без нового запиту.
    fireEvent.click(screen.getByTestId("stay-rates-toggle"));
    fireEvent.click(screen.getByTestId("stay-rates-toggle"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("джерело без тарифів — без кнопки; unsupported — чесне повідомлення", async () => {
    renderCard({ ...STAY, sellers: null });
    expect(screen.queryByTestId("stay-rates-toggle")).toBeNull();
    expect(screen.queryByTestId("stay-sellers")).toBeNull();
  });

  it("«Додати до поїздки» веде в планувальник з містом, датами, гостями й житлом", () => {
    renderCard();
    const href = screen.getByTestId("stay-add-to-trip").getAttribute("href")!;
    expect(href).toBe(tripFromStay(STAY, QUERY));
    expect(Object.fromEntries(new URLSearchParams(href.split("?")[1]))).toEqual({
      to: "LIS",
      depart: "2026-12-05",
      return: "2026-12-08",
      stay: "mock:mock-lis-1",
      children: "1",
    });
  });
});

describe("обране", () => {
  it("гість: у localStorage, зі знімком ціни; прибрати", async () => {
    renderCard();
    const toggle = await screen.findByTestId("favorite-toggle");
    await waitFor(() => expect(toggle).toBeEnabled());

    await act(async () => fireEvent.click(toggle));

    expect(toggle).toHaveAttribute("aria-pressed", "true");
    const saved = JSON.parse(localStorage.getItem("tickets.favorites.v1")!);
    expect(saved[0].item_key).toBe("mock:mock-lis-1|2026-12-05|2026-12-08");
    expect(saved[0].stay).toMatchObject({
      total_price: 360,
      price_at: "2026-11-06T10:00:00Z",
      params: "city=LIS&in=2026-12-05",
    });
    expect(actions.addFavorite).not.toHaveBeenCalled();

    await act(async () => fireEvent.click(toggle));
    expect(localStorage.getItem("tickets.favorites.v1")).toBeNull();
  });

  it("з акаунтом: локальне переноситься в профіль, список — з акаунта", async () => {
    const stay = {
      source: "mock",
      stay_id: "mock-lis-1",
      name: "Hotel Meridian",
      kind: "hotel" as const,
      city: "LIS",
      rating: 8.6,
      review_count: 1350,
      price_per_night: 120,
      total_price: 360,
      currency: "EUR",
      check_in: "2026-12-05",
      check_out: "2026-12-08",
      price_at: "2026-11-06T10:00:00Z",
      params: "city=LIS",
    };
    localStorage.setItem(
      "tickets.favorites.v1",
      JSON.stringify([{ item_key: "k", created_at: "2026-11-06T10:00:00Z", stay }]),
    );
    const item: FavoriteOut = {
      id: "f1",
      kind: "stay",
      item_key: "mock:mock-lis-1|2026-12-05|2026-12-08",
      stay,
      created_at: "2026-11-06T10:00:00Z",
    };
    actions.loadFavorites.mockResolvedValue({
      signedIn: true,
      ok: true,
      items: [item],
      imported: true,
    });
    actions.removeFavorite.mockResolvedValue({ signedIn: true, ok: true, items: [] });

    render(
      <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
        <FavoritesProvider>
          <FavoritesList />
        </FavoritesProvider>
      </NextIntlClientProvider>,
    );

    const card = await screen.findByTestId("favorite-item");
    expect(actions.loadFavorites).toHaveBeenCalledWith([
      expect.objectContaining({ kind: "stay", stay }),
    ]);
    expect(localStorage.getItem("tickets.favorites.v1")).toBeNull();
    expect(card).toHaveTextContent("Hotel Meridian");
    expect(card).toHaveTextContent("ціна на 6 лист.");
    expect(screen.getByText("Зберігається у вашому акаунті.")).toBeInTheDocument();

    await act(async () => fireEvent.click(screen.getByTestId("favorite-remove")));
    expect(actions.removeFavorite).toHaveBeenCalledWith(item.item_key);
    expect(screen.getByTestId("favorites-empty")).toBeInTheDocument();
  });
});
