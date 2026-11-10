import type {
  CheaperResult,
  Offer,
  Stay,
  TripCombo,
  TripQuery,
  TripSearchResult,
} from "@tickets/shared";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../messages/uk.json";
import { FavoritesProvider } from "./favorites";
import { SavedTripsList, SavedTripsProvider } from "./saved-trips";
import { TripBuilder } from "./trip-builder";
import { TripCompareBar, TripCompareProvider } from "./trip-compare";
import { TripCheaper } from "./trip-cheaper";
import { TripUndo } from "./trip-history";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const actions = vi.hoisted(() => ({
  loadSavedTrips: vi.fn(),
  createSavedTrip: vi.fn(),
  updateSavedTrip: vi.fn(),
  renameSavedTrip: vi.fn(),
  deleteSavedTrip: vi.fn(),
}));
vi.mock("@/app/actions/saved-trips", () => actions);
const favoriteActions = vi.hoisted(() => ({
  loadFavorites: vi.fn(),
  addFavorite: vi.fn(),
  removeFavorite: vi.fn(),
}));
vi.mock("@/app/actions/favorites", () => favoriteActions);

const LEG = {
  origin: "WAW",
  destination: "LIS",
  departure_at: "2026-12-05T06:10:00+01:00",
  arrival_at: "2026-12-05T09:30:00+00:00",
  duration_min: 260,
  stops: 0,
};

function offer(id: string, price: number): Offer {
  return {
    id,
    source: "mock",
    price,
    currency: "EUR",
    outbound: LEG,
    inbound: {
      ...LEG,
      origin: "LIS",
      destination: "WAW",
      departure_at: "2026-12-08T10:00:00+00:00",
      arrival_at: "2026-12-08T15:20:00+01:00",
    },
    airlines: ["LO"],
    details_level: "full",
    collected_at: "2026-11-06T10:00:00Z",
    stops: 0,
    total_duration_min: 520,
  } as Offer;
}

function stay(id: string, total: number): Stay {
  return {
    id,
    source: "mock",
    name: `Hotel ${id}`,
    kind: "hotel",
    price_per_night: total / 3,
    total_price: total,
    currency: "EUR",
    nights: 3,
    rating: 8.4,
    review_count: 100,
    distance_to_center_km: 1.2,
    collected_at: "2026-11-06T10:00:00Z",
  } as Stay;
}

const WINDOW = { check_in: "2026-12-05", check_out: "2026-12-08", nights: 3 };
const SELECTED: TripCombo = {
  key: "mock:f1|mock:s1",
  offer_key: "mock:f1",
  stay_key: "mock:s1",
  stay_index: 0,
  window: WINDOW,
  arrival_at: LEG.arrival_at,
  return_departure_at: "2026-12-08T10:00:00+00:00",
  flight_price: 200,
  flight_total: 200,
  stay_total: 300,
  costs: {
    items: [
      { kind: "tickets", amount: 200, status: "confirmed", included: false },
      { kind: "stay", amount: 300, status: "confirmed", included: false },
    ],
    confirmed: 500,
    approximate: 0,
    unknown: 0,
  },
  money_total: 500,
  value_total: 520,
  stops: 0,
  currency: "EUR",
  warnings: [],
  full_nights: 3,
  reasons: [],
  converted_from: [],
};
const QUERY: TripQuery = {
  origin: "WAW",
  destination: "LIS",
  departure_date: "2026-12-05",
  return_date: "2026-12-08",
  flight: "mock:f1",
  stay: "mock:s1",
} as TripQuery;
const DATA = {
  offers: [offer("f1", 200), offer("f2", 150)],
  stays: [stay("s1", 300), stay("s2", 420)],
  flight_options: [
    { offer_key: "mock:f1", window: WINDOW, flight_total: 200, baggage_unknown: false },
    { offer_key: "mock:f2", window: WINDOW, flight_total: 150, baggage_unknown: false },
  ],
  stay_options: [0, 1],
  pinned_flight: "used",
  pinned_stay: "unavailable",
} as unknown as TripSearchResult;

function wrap(node: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
      <SavedTripsProvider>
        <FavoritesProvider>
          <TripCompareProvider>
            {node}
            <TripCompareBar />
          </TripCompareProvider>
        </FavoritesProvider>
      </SavedTripsProvider>
    </NextIntlClientProvider>,
  );
}

function builder() {
  return (
    <TripBuilder
      data={DATA}
      query={QUERY}
      selected={SELECTED}
      travelers="2 дорослі"
      airlineNames={{ LO: "LOT" }}
      flightsHref="/"
      staysHref="/stays"
      title="WAW → LIS"
      pricedAt="2026-11-06T12:00:00Z"
    />
  );
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  actions.loadSavedTrips.mockResolvedValue({ signedIn: false });
  favoriteActions.loadFavorites.mockResolvedValue({ signedIn: false });
});
afterEach(() => {
  vi.restoreAllMocks();
  push.mockReset();
});

describe("Ваша поїздка", () => {
  it("заміна рейсу зберігає житло, заміна житла — рейс; різниця до поточного", () => {
    wrap(builder());

    const flights = within(screen.getByTestId("trip-flight-options")).getAllByTestId("trip-option");
    expect(flights).toHaveLength(1); // поточний рейс у варіантах не дублюємо
    expect(flights[0]).toHaveTextContent(/−50\s€/);
    // Заміна відкриває сторінку одразу на «Вашій поїздці» (модуль 23b).
    expect(flights[0].getAttribute("href")).toMatch(/#your-trip$/);
    const query = (href: string | null) => new URLSearchParams(href!.split("#")[0].split("?")[1]);
    const flightUrl = query(flights[0].getAttribute("href"));
    expect([flightUrl.get("flight"), flightUrl.get("stay")]).toEqual(["mock:f2", "mock:s1"]);

    const stays = within(screen.getByTestId("trip-stay-options")).getAllByTestId("trip-option");
    expect(stays).toHaveLength(1);
    expect(stays[0]).toHaveTextContent(/\+120\s€/);
    const stayUrl = query(stays[0].getAttribute("href"));
    expect([stayUrl.get("flight"), stayUrl.get("stay")]).toEqual(["mock:f1", "mock:s2"]);

    // Житла немає на дати рейсу — чесно кажемо, що підібрали інше.
    expect(screen.getByTestId("trip-builder-notice")).toHaveTextContent("Обраного житла немає");
    const reset = new URLSearchParams(
      screen.getByTestId("trip-reset").getAttribute("href")!.split("?")[1],
    );
    expect(reset.has("flight") || reset.has("stay")).toBe(false);
  });
});

describe("Знайти дешевший варіант", () => {
  it("було → стало, різниця, що змінилося, застосувати", async () => {
    const result: CheaperResult = {
      status: "found",
      before: SELECTED,
      after: { ...SELECTED, key: "mock:f2|mock:s1", offer_key: "mock:f2", money_total: 430 },
      saving: 70,
      changes: ["dates", "flight"],
      apply: { ...QUERY, flight: "mock:f2", departure_date: "2026-12-06" } as never,
      offers: [offer("f1", 200), offer("f2", 150)],
      stays: [stay("s1", 300), stay("s1", 280)],
      flights_checked: 40,
      combos_checked: 18,
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(result)));
    render(
      <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
        <TripCheaper query={QUERY} />
      </NextIntlClientProvider>,
    );

    await act(async () => fireEvent.click(screen.getByTestId("trip-cheaper")));

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      flight: "mock:f1",
    });
    const box = screen.getByTestId("trip-cheaper-result");
    expect(box).toHaveTextContent(/500\s€/);
    expect(box).toHaveTextContent(/430\s€/);
    expect(box).toHaveTextContent(/дешевше на 70\s€/);
    expect(box).toHaveTextContent("Інші дати: 5 груд. – 8 груд.");
    expect(box).toHaveTextContent("Інший рейс: WAW → LIS");
    expect(box).toHaveTextContent("Перевірено 40 рейсів і 18 комбінацій");
    expect(screen.getByTestId("trip-cheaper-apply").getAttribute("href")).toContain(
      "flight=mock%3Af2",
    );
  });

  it("нічого не знайшли — так і кажемо", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "not_found",
          before: SELECTED,
          flights_checked: 5,
          combos_checked: 3,
        }),
      ),
    );
    render(
      <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
        <TripCheaper query={QUERY} />
      </NextIntlClientProvider>,
    );

    await act(async () => fireEvent.click(screen.getByTestId("trip-cheaper")));

    expect(screen.getByTestId("trip-cheaper-result")).toHaveTextContent(
      "Дешевшого варіанта за ваших умов не знайшлося.",
    );
  });
});

describe("Повернути попередній вибір", () => {
  it("стек станів вкладки: кнопка веде на попередній", () => {
    const intl = (node: React.ReactNode) => (
      <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
        {node}
      </NextIntlClientProvider>
    );
    const { rerender } = render(intl(<TripUndo params="a=1" showButton />));
    expect(screen.queryByTestId("trip-undo")).toBeNull();
    rerender(intl(<TripUndo params="a=1&stay=x" showButton />));

    fireEvent.click(screen.getByTestId("trip-undo"));

    expect(push).toHaveBeenCalledWith("/trip?a=1", { scroll: false });
    expect(JSON.parse(sessionStorage.getItem("tickets.tripHistory.v1")!)).toEqual(["a=1"]);
  });
});

describe("Збереження й порівняння поїздок", () => {
  it("гість зберігає структуровані дані; список — з історичною ціною, копія, видалення", async () => {
    wrap(builder());
    const save = await screen.findByTestId("trip-save");
    await act(async () => fireEvent.click(save));

    const stored = JSON.parse(localStorage.getItem("tickets.savedTrips.v1")!);
    expect(stored).toHaveLength(1);
    expect(stored[0].query).toMatchObject({ flight: "mock:f1", stay: "mock:s1" });
    expect(stored[0].snapshot).toMatchObject({
      money_total: 500,
      nights: 3,
      priced_at: "2026-11-06T12:00:00Z",
      flight: { origin: "WAW", price: 200, price_status: "cached" },
      stay: { name: "Hotel s1", total_price: 300 },
    });
    expect(actions.createSavedTrip).not.toHaveBeenCalled();
    expect(screen.getByTestId("trip-save")).toHaveTextContent("Збережено");

    // «Поділитися» — посилання на ту саму конфігурацію.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    // Кнопка оживає після гідратації й може перемонтуватись (key від стану) — під навантаженням
    // це не миттєво, тож клікаємо, доки не спрацює.
    await waitFor(async () => {
      await act(async () => fireEvent.click(screen.getByTestId("trip-share")));
      expect(writeText).toHaveBeenCalled();
    });
    expect(writeText.mock.calls[0][0]).toContain("flight=mock%3Af1");
  });

  it("Мої поїздки: оновити ціни показує різницю й зниклий рейс; копія й видалення", async () => {
    const now = "2026-11-06T12:00:00Z";
    localStorage.setItem(
      "tickets.savedTrips.v1",
      JSON.stringify([
        {
          id: "local-1",
          title: "Лісабон",
          created_at: now,
          updated_at: now,
          query: QUERY,
          snapshot: {
            money_total: 500,
            confirmed: 500,
            approximate: 0,
            unknown: 0,
            currency: "EUR",
            check_in: "2026-12-05",
            check_out: "2026-12-08",
            nights: 3,
            flight: {
              origin: "WAW",
              destination: "LIS",
              departure_at: LEG.departure_at,
              arrival_at: LEG.arrival_at,
              return_departure_at: "2026-12-08T10:00:00+00:00",
              return_arrival_at: "2026-12-08T15:20:00+01:00",
              stops: 0,
              duration_min: 520,
              airlines: ["LO"],
              price: 200,
              price_status: "cached",
            },
            stay: { name: "Hotel s1", kind: "hotel", rating: 8.4, total_price: 300 },
            priced_at: now,
          },
        },
      ]),
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          current: { ...SELECTED, money_total: 540 },
          flight_available: false,
          stay_available: true,
          difference: 40,
          checked_at: now,
        }),
      ),
    );
    wrap(<SavedTripsList />);

    const card = await screen.findByTestId("saved-trip");
    expect(card).toHaveTextContent(/500\s€/);
    expect(card).toHaveTextContent("сума на 6 лист.");
    expect(within(card).getByTestId("saved-trip-open").getAttribute("href")).toContain(
      "saved=local-1",
    );

    await act(async () => fireEvent.click(within(card).getByTestId("saved-trip-refresh")));
    const note = screen.getByTestId("saved-trip-refreshed");
    expect(note).toHaveTextContent(/Зараз: 540\s€ дорожче на 40\s€/);
    expect(note).toHaveTextContent("Обраного рейсу вже немає");

    await act(async () => fireEvent.click(within(card).getByTestId("saved-trip-copy")));
    expect(screen.getAllByTestId("saved-trip")).toHaveLength(2);
    expect(screen.getByText("Лісабон (копія)")).toBeInTheDocument();

    const first = screen.getAllByTestId("saved-trip")[0];
    fireEvent.click(within(first).getByTestId("saved-trip-delete"));
    await act(async () => fireEvent.click(within(first).getByTestId("saved-trip-delete-yes")));
    expect(screen.getAllByTestId("saved-trip")).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem("tickets.savedTrips.v1")!)).toHaveLength(1);
  });

  it("порівняння: до трьох, таблиця з бюджетом, тривалістю, рейтингом і скасуванням", async () => {
    wrap(builder());
    await act(async () => fireEvent.click(await screen.findByTestId("trip-compare-toggle")));
    expect(screen.getByTestId("trip-compare-bar")).toHaveTextContent("Обрано поїздок: 1 з 3");
    expect(screen.getByTestId("trip-compare-open")).toBeDisabled(); // одну — не порівнюємо

    const stored = JSON.parse(sessionStorage.getItem("tickets.tripCompare.v1")!);
    expect(stored[0].snapshot.stay.name).toBe("Hotel s1");
  });

  it("таблиця двох поїздок: найкраще — зеленим, дні й ночі, скасування", async () => {
    const snap = (total: number, rating: number, stops: number) => ({
      money_total: total,
      confirmed: total,
      approximate: 0,
      unknown: 0,
      currency: "EUR",
      check_in: "2026-12-05",
      check_out: "2026-12-08",
      nights: 3,
      flight: {
        origin: "WAW",
        destination: "LIS",
        departure_at: "2026-12-04T23:40:00+01:00",
        arrival_at: "2026-12-05T02:10:00+00:00",
        return_departure_at: "2026-12-08T10:00:00+00:00",
        return_arrival_at: "2026-12-08T15:20:00+01:00",
        stops,
        duration_min: 500 + stops * 120,
        airlines: ["LO"],
        price: total - 300,
        price_status: "live",
      },
      stay: {
        name: `Hotel ${rating}`,
        kind: "hotel",
        rating,
        review_count: 10,
        district: "Центр",
        distance_to_center_km: 1,
        cancellation: "free",
        total_price: 300,
      },
      priced_at: "2026-11-06T12:00:00Z",
    });
    sessionStorage.setItem(
      "tickets.tripCompare.v1",
      JSON.stringify([
        { key: "a", title: "Економ", snapshot: snap(500, 7.5, 1) },
        { key: "b", title: "Комфорт", snapshot: snap(700, 9.1, 0) },
      ]),
    );
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    wrap(null);

    fireEvent.click(await screen.findByTestId("trip-compare-open"));

    const table = screen.getByTestId("trip-compare-table");
    expect(table).toHaveTextContent("Економ");
    expect(table).toHaveTextContent("Комфорт");
    // Виліт 4-го пізно ввечері, повернення 8-го: 5 днів у дорозі, 3 ночі в житлі.
    expect(table).toHaveTextContent("5 днів, 3 ночі");
    expect(table).toHaveTextContent("Безкоштовне скасування");
    const totals = within(table).getByText("Загальний бюджет (відоме)").closest("tr")!;
    expect(within(totals).getByText(/500\s€/).className).toContain("success");
    const rating = within(table).getByText("Рейтинг житла").closest("tr")!;
    expect(within(rating).getByText(/9,1/).className).toContain("success");
  });
});
