import type { FavoriteBody } from "@tickets/shared";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../messages/uk.json";
import { FavoritesList, FavoritesProvider, FavoriteToggle } from "./favorites";
import { SavedTripsList, SavedTripsProvider } from "./saved-trips";
import { TripCompareProvider } from "./trip-compare";

const favActions = vi.hoisted(() => ({
  loadFavorites: vi.fn(),
  addFavorite: vi.fn(),
  removeFavorite: vi.fn(),
}));
vi.mock("@/app/actions/favorites", () => favActions);
const tripActions = vi.hoisted(() => ({
  loadSavedTrips: vi.fn(),
  createSavedTrip: vi.fn(),
  updateSavedTrip: vi.fn(),
  patchSavedTrip: vi.fn(),
  deleteSavedTrip: vi.fn(),
}));
vi.mock("@/app/actions/saved-trips", () => tripActions);

const FLIGHT: FavoriteBody = {
  kind: "flight",
  flight: {
    source: "mock",
    offer_id: "abc123",
    origin: "WAW",
    destination: "LIS",
    departure_at: "2026-12-05T06:10:00+01:00",
    arrival_at: "2026-12-05T09:30:00+00:00",
    return_departure_at: "2026-12-08T10:00:00+00:00",
    stops: 0,
    airlines: ["LO"],
    passengers: 2,
    price: 230,
    currency: "EUR",
    price_status: "cached",
    price_at: "2026-11-07T10:00:00Z",
    params: "from=WAW&to=LIS&depart=2026-12-05&return=2026-12-08&adults=2",
  },
};
const SNAPSHOT = {
  money_total: 520,
  confirmed: 520,
  approximate: 0,
  unknown: 0,
  currency: "EUR",
  check_in: "2026-12-05",
  check_out: "2026-12-08",
  nights: 3,
  flight: {
    origin: "WAW",
    destination: "LIS",
    departure_at: "2026-12-05T06:10:00+01:00",
    return_departure_at: "2026-12-08T10:00:00+00:00",
    stops: 0,
    airlines: ["LO"],
    price: 230,
    price_status: "live" as const,
  },
  stay: { name: "Hotel Riverside", kind: "hotel" as const, total_price: 290 },
  priced_at: "2026-11-07T10:00:00Z",
};
const QUERY = {
  origin: "WAW",
  destination: "LIS",
  departure_date: "2026-12-05",
  return_date: "2026-12-08",
  flight: "mock:abc123",
  stay: "mock:mock-lis-3",
};
const TRIP: FavoriteBody = {
  kind: "trip",
  trip: { title: "Лісабон", query: QUERY as never, snapshot: SNAPSHOT as never },
};

function wrap(node: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
      <FavoritesProvider>
        <SavedTripsProvider>
          <TripCompareProvider>{node}</TripCompareProvider>
        </SavedTripsProvider>
      </FavoritesProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  favActions.loadFavorites.mockResolvedValue({ signedIn: false });
  tripActions.loadSavedTrips.mockResolvedValue({ signedIn: false });
});

describe("обране за категоріями (модуль 10a)", () => {
  it("квиток і поїздка: додати, вкладки, повторити пошук, до планувальника", async () => {
    wrap(
      <>
        <FavoriteToggle body={FLIGHT} />
        <FavoriteToggle body={TRIP} />
        <FavoritesList />
      </>,
    );
    const [flightToggle, tripToggle] = await screen.findAllByTestId("favorite-toggle");
    await act(async () => fireEvent.click(flightToggle));
    await act(async () => fireEvent.click(tripToggle));

    const stored = JSON.parse(localStorage.getItem("tickets.favorites.v1")!);
    expect(stored.map((i: { kind: string; item_key: string }) => [i.kind, i.item_key])).toEqual([
      ["trip", "trip|mock:abc123|mock:mock-lis-3|2026-12-05"],
      ["flight", "mock:abc123"],
    ]);
    expect(screen.getByTestId("favorites-tab-flight")).toHaveTextContent("Квитки (1)");

    fireEvent.click(screen.getByTestId("favorites-tab-flight"));
    const flight = screen.getByTestId("favorite-item");
    expect(flight).toHaveTextContent("WAW → LIS");
    expect(flight).toHaveTextContent("ціна на 7 лист.");
    const [again, planner] = within(flight).getAllByRole("link");
    expect(again.getAttribute("href")).toBe(`/?${FLIGHT.flight!.params}`);
    expect(
      Object.fromEntries(new URLSearchParams(planner.getAttribute("href")!.split("?")[1])),
    ).toMatchObject({
      from: "WAW",
      to: "LIS",
      depart: "2026-12-05",
      return: "2026-12-08",
      adults: "2",
      flight: "mock:abc123",
    });

    fireEvent.click(screen.getByTestId("favorites-tab-trip"));
    const trip = screen.getByTestId("favorite-item");
    expect(trip).toHaveAttribute("data-kind", "trip");
    expect(within(trip).getByRole("link").getAttribute("href")).toContain("stay=mock%3Amock-lis-3");
  });

  it("старі записи браузера (модуль 7, без категорії) — житло", async () => {
    localStorage.setItem(
      "tickets.favorites.v1",
      JSON.stringify([
        {
          item_key: "mock:mock-lis-3|2026-12-05|2026-12-08",
          created_at: "2026-11-06T10:00:00Z",
          stay: {
            source: "mock",
            stay_id: "mock-lis-3",
            name: "Hotel Riverside",
            kind: "hotel",
            city: "LIS",
            price_per_night: 95,
            total_price: 285,
            currency: "EUR",
            check_in: "2026-12-05",
            check_out: "2026-12-08",
            price_at: "2026-11-06T10:00:00Z",
            params: "city=LIS",
          },
        },
      ]),
    );
    wrap(<FavoritesList />);

    expect(await screen.findByTestId("favorites-tab-stay")).toHaveTextContent("Житло (1)");
    expect(screen.getByTestId("favorite-item")).toHaveAttribute("data-kind", "stay");
  });
});

describe("статуси поїздок (модуль 10a)", () => {
  it("чернетка за замовчуванням, зміна статусу, фільтр, підказка про минулі дати", async () => {
    const now = "2026-11-06T12:00:00Z";
    const past = { ...SNAPSHOT, check_in: "2020-01-05", check_out: "2020-01-08" };
    localStorage.setItem(
      "tickets.savedTrips.v1",
      JSON.stringify([
        {
          id: "local-1",
          title: "Лісабон",
          created_at: now,
          updated_at: now,
          query: QUERY,
          snapshot: SNAPSHOT,
        },
        {
          id: "local-2",
          title: "Минула",
          created_at: now,
          updated_at: now,
          query: QUERY,
          snapshot: past,
        },
      ]),
    );
    wrap(<SavedTripsList />);

    const selects = await screen.findAllByTestId("saved-trip-status");
    expect(selects.map((s) => (s as HTMLSelectElement).value)).toEqual(["draft", "draft"]);
    expect(screen.getByText(/Дати вже минули/)).toBeInTheDocument();
    expect(screen.queryByText(/заброньован/i)).toBeNull();

    await act(async () => fireEvent.change(selects[0], { target: { value: "planned" } }));
    const stored = JSON.parse(localStorage.getItem("tickets.savedTrips.v1")!);
    expect(stored[0].status).toBe("planned");
    fireEvent.click(screen.getByTestId("trips-filter-planned"));
    expect(screen.getAllByTestId("saved-trip")).toHaveLength(1);
    expect(screen.getByTestId("trips-filter-draft")).toHaveTextContent("Чернетки (1)");
  });
});
