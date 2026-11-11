import type { ExploreDestination, ExploreQuery } from "@tickets/shared";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../messages/uk.json";

import { ExploreCard } from "./explore-card";
import { ExploreCompareBar, ExploreCompareProvider } from "./explore-compare";
import { ExploreForm } from "./explore-form";
import { FavoritesProvider } from "./favorites";

vi.mock("@/app/actions/favorites", () => ({
  loadFavorites: vi.fn().mockResolvedValue({ signedIn: false }),
  addFavorite: vi.fn(),
  removeFavorite: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/explore",
  useSearchParams: () => new URLSearchParams(),
}));

const QUERY: ExploreQuery = {
  origins: ["AMS"],
  departure_date: "2026-12-01",
  departure_until: "2026-12-31",
  min_nights: 2,
  max_nights: 4,
  adults: 2,
  budget: 600,
  mode: "trip",
  weekends: false,
  direct_only: false,
  currency: "EUR",
  lang: "uk",
  limit: 30,
};

function destination(code: string, city: string, overrides: Partial<ExploreDestination> = {}) {
  return {
    code,
    city_name: city,
    country: "IE",
    lat: 53.3,
    lon: -6.2,
    categories: ["city", "nightlife"],
    photo: {
      url: `https://upload.wikimedia.org/${code}.jpg`,
      page: `https://en.wikipedia.org/wiki/${city}`,
    },
    nights: 2,
    nights_approximate: false,
    freshness: "cached",
    stay_status: "not_checked",
    offer: {
      id: code,
      source: "travelpayouts",
      price: 144,
      currency: "EUR",
      outbound: {
        origin: "AMS",
        destination: code,
        departure_at: "2026-12-14T12:40:00+01:00",
        duration_min: 100,
        stops: 0,
      },
      inbound: {
        origin: code,
        destination: "AMS",
        departure_at: "2026-12-16T09:30:00Z",
        duration_min: 100,
        stops: 0,
      },
    },
    ...overrides,
  } as unknown as ExploreDestination;
}

const DUBLIN = destination("DUB", "Дублін", {
  stay_status: "ok",
  stay: {
    id: "s1",
    source: "mock",
    name: "Hotel Liffey",
    rating: 8.6,
    total_price: 210,
    currency: "EUR",
    taxes_included: null,
  },
  total: 354,
} as Partial<ExploreDestination>);
const LONDON = destination("LON", "Лондон");

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
      <FavoritesProvider>{ui}</FavoritesProvider>
    </NextIntlClientProvider>,
  );
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
  };
});

beforeEach(() => sessionStorage.clear());

describe("Explore (ADR 0045)", () => {
  it("картка: фото з атрибуцією, загальна сума, житло й переходи до рейсів і поїздки", () => {
    wrap(
      <ExploreCompareProvider>
        <ExploreCard destination={DUBLIN} query={QUERY} countryName="Ірландія" />
      </ExploreCompareProvider>,
    );

    const card = screen.getByTestId("explore-card");
    expect(within(card).getByRole("img")).toHaveAttribute(
      "src",
      "https://upload.wikimedia.org/DUB.jpg",
    );
    expect(within(card).getByRole("link", { name: "Фото: Вікіпедія" })).toHaveAttribute(
      "href",
      "https://en.wikipedia.org/wiki/Дублін",
    );
    expect(screen.getByTestId("explore-price")).toHaveTextContent("354");
    expect(card).toHaveTextContent("переліт + житло, 2 дорослі");
    expect(screen.getByTestId("explore-stay")).toHaveTextContent("Hotel Liffey");
    expect(screen.getByTestId("explore-stay")).toHaveTextContent("податки уточнює продавець");
    expect(screen.getByTestId("explore-to-flights")).toHaveAttribute(
      "href",
      "/?from=AMS&to=DUB&depart=2026-12-14&return=2026-12-16&adults=2",
    );
    expect(screen.getByTestId("explore-to-trip")).toHaveAttribute(
      "href",
      "/trip?from=AMS&to=DUB&depart=2026-12-14&return=2026-12-16&adults=2&budget=600",
    );
  });

  it("житло не рахували — так і пишемо, ціна — лише переліт", () => {
    wrap(
      <ExploreCompareProvider>
        <ExploreCard destination={LONDON} query={QUERY} countryName="Велика Британія" />
      </ExploreCompareProvider>,
    );
    expect(screen.getByTestId("explore-stay")).toHaveTextContent("Житло — у поїздці");
    expect(screen.getByTestId("explore-card")).toHaveTextContent("туди й назад, 2 дорослі");
  });

  it("порівняння до трьох: поруч ціни, ночі й «не рахували» для житла", () => {
    wrap(
      <ExploreCompareProvider>
        <ExploreCard destination={DUBLIN} query={QUERY} countryName="Ірландія" />
        <ExploreCard destination={LONDON} query={QUERY} countryName="Велика Британія" />
        <ExploreCompareBar />
      </ExploreCompareProvider>,
    );

    const toggles = screen.getAllByTestId("explore-compare-toggle");
    fireEvent.click(toggles[0]);
    fireEvent.click(toggles[1]);
    expect(screen.getByTestId("explore-compare-bar")).toHaveTextContent("Обрано 2 з 3");
    fireEvent.click(screen.getByTestId("explore-compare-open"));

    const table = screen.getByTestId("explore-compare-table");
    expect(table).toHaveTextContent("Дублін");
    expect(table).toHaveTextContent("Лондон");
    expect(table).toHaveTextContent("не рахували");
    expect(table).toHaveTextContent("3 год 20 хв");
    // Телефон — ті самі дані картками.
    expect(within(screen.getByTestId("explore-compare-cards")).getAllByText(/Разом/)).toHaveLength(
      2,
    );
    expect(JSON.parse(sessionStorage.getItem("tickets.exploreCompare.v1") ?? "[]")).toHaveLength(2);
  });

  it("форма: «не знаю» першим, дата ± похибка → період вильоту, службові поля не в URL", () => {
    // Поле місця підтягує назву за кодом — без мережі в тестах.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]"));
    const { container } = wrap(
      <ExploreForm
        initial={{
          origins: ["AMS"],
          departure_date: "2026-12-03",
          departure_until: "2026-12-17",
          min_nights: 2,
          max_nights: 4,
        }}
        today="2026-11-11"
      />,
    );
    const value = (name: string) =>
      container.querySelector<HTMLInputElement>(`input[type="hidden"][name="${name}"]`)?.value;

    const where = within(screen.getByTestId("explore-where")).getAllByRole("button");
    expect(where[0]).toHaveAttribute("aria-pressed", "true");
    expect(where[0]).toHaveTextContent("Не знаю — будь-куди");
    expect(container.querySelector<HTMLInputElement>("#explore-date")!.value).toBe("2026-12-10");
    expect([value("depart"), value("until"), value("nmin"), value("nmax")]).toEqual([
      "2026-12-03",
      "2026-12-17",
      "2",
      "4",
    ]);
    expect(value("to")).toBeUndefined();

    fireEvent.click(screen.getByText("± 3 дні"));
    expect([value("depart"), value("until")]).toEqual(["2026-12-07", "2026-12-13"]);
    fireEvent.click(screen.getByText("7–14 ночей"));
    expect([value("nmin"), value("nmax")]).toEqual(["7", "14"]);

    fireEvent.click(screen.getByTestId("explore-where-asia"));
    expect(value("to")).toBe("asia");
    fireEvent.click(screen.getByTestId("explore-where-sea"));
    expect(value("to")).toBeUndefined();
    expect(value("cat")).toBe("sea");

    // Перемикачі — кнопки, не поля форми: адреса пошуку лише з прихованих полів.
    const keys = [...new FormData(container.querySelector("form")!).keys()];
    expect(keys.filter((k) => !["budget", "cur", "adults", "mode"].includes(k))).toEqual([
      "cat",
      "from",
      "depart",
      "until",
      "nmin",
      "nmax",
    ]);
    expect(screen.getByTestId("entry-notice")).toHaveTextContent("віза");
  });
});
