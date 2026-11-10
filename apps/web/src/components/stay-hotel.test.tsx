import type { Stay, StayQuery, StayRatesResult } from "@tickets/shared";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import messages from "../../messages/uk.json";
import { stayHotelHref } from "@/lib/stay-params";

import { StayCard } from "./stay-card";
import { StayGallery } from "./stay-gallery";
import { StayHotelRates } from "./stay-hotel-rates";

const NOW = new Date("2026-11-10T12:00:00Z");
const PHOTOS = Array.from(
  { length: 7 },
  (_, i) => `https://lh3.googleusercontent.com/p${i}=w1280-h853-k-no`,
);

const STAY: Stay = {
  id: "gh-abc",
  source: "scrapedo",
  name: "Hotel Aurora",
  kind: "hotel",
  stars: 4,
  price_per_night: 120,
  total_price: 360,
  taxes_included: null,
  currency: "EUR",
  nights: 3,
  rooms: 1,
  rating: 9.2,
  review_count: 812,
  amenities: [],
  image_url: "https://lh3.googleusercontent.com/p0=s287-w287-h192-n-k-no-v1",
  images: PHOTOS,
  description: "Rooms with a view.",
  check_in_time: "3:00 PM",
  check_out_time: "12:00 PM",
  booking_ref: "token",
  deep_link: "https://www.google.com/travel/search?q=Hotel+Aurora+Lisbon",
  sellers: null,
  collected_at: "2026-11-10T11:50:00Z",
  found_at: "2026-11-10T11:50:00Z",
};

const QUERY: StayQuery = {
  city: "LIS",
  check_in: "2026-12-13",
  check_out: "2026-12-16",
  guests: { adults: 2, children: 0, rooms: 1 },
  currency: "EUR",
  profile: "balanced",
  filters: {
    free_cancellation: false,
    breakfast_included: false,
    no_prepayment: false,
    pay_at_property: false,
  },
};

const RATES: StayRatesResult = {
  status: "ok",
  sellers: 2,
  nights: 3,
  checked_at: "2026-11-10T11:59:00Z",
  rooms: [
    {
      key: "name:|||",
      room_name: "",
      bed_type: null,
      meal: null,
      cancellation: null,
      offers: [
        {
          rate: {
            seller: "Hotel Aurora",
            is_property: true,
            sponsored: true,
            room_name: "",
            price_total: 355,
            currency: "EUR",
            deep_link: "https://www.google.com/aclk?sa=l",
            checked_at: "2026-11-10T11:59:00Z",
          },
          final_total: null,
          cheapest: false,
        },
        {
          rate: {
            seller: "Trip.com",
            is_property: false,
            sponsored: false,
            room_name: "",
            price_total: 370,
            currency: "EUR",
            deep_link: "https://www.google.com/travel/lodging/clk?pc=x",
            checked_at: "2026-11-10T11:59:00Z",
          },
          final_total: null,
          cheapest: false,
        },
      ],
    },
  ],
};

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>,
  );
}

beforeAll(() => {
  // jsdom не вміє модальні <dialog>.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("сторінка об'єкта житла (ADR 0044)", () => {
  it("картка веде на сторінку об'єкта й на сайт; податки — чесно «уточнює продавець»", () => {
    const href = stayHotelHref("city=LIS&in=2026-12-13&out=2026-12-16&view=map", STAY);
    wrap(<StayCard stay={STAY} now={NOW} detailHref={href} />);

    expect(href).toBe("/stays/hotel?city=LIS&in=2026-12-13&out=2026-12-16&src=scrapedo&id=gh-abc");
    expect(screen.getByTestId("stay-open")).toHaveAttribute("href", href);
    expect(screen.getByTestId("stay-open-details")).toHaveTextContent("Фото й деталі");
    expect(screen.getByTestId("stay-photo")).toBeInTheDocument();
    const site = screen.getByTestId("stay-site");
    expect(site).toHaveTextContent("Відкрити в Google Hotels");
    expect(site.getAttribute("href")).toMatch(
      /^\/out\?url=https%3A%2F%2Fwww\.google\.com%2Ftravel/,
    );
    expect(screen.getByText(/чи є податки в ціні — уточнює продавець/)).toBeInTheDocument();
    expect(screen.getByText(/через Google Hotels/)).toBeInTheDocument();
  });

  it("галерея: 5 фото на виду, решта — «Ще N»; перегляд гортається", () => {
    wrap(<StayGallery photos={PHOTOS} name="Hotel Aurora" />);

    const thumbs = screen.getAllByTestId("stay-photo-thumb");
    expect(thumbs).toHaveLength(5);
    expect(thumbs[4]).toHaveTextContent("Ще 2");

    fireEvent.click(thumbs[1]);
    const lightbox = screen.getByTestId("stay-lightbox");
    expect(lightbox).toHaveAttribute("open");
    expect(lightbox).toHaveTextContent("2 / 7");
    fireEvent.click(screen.getByTestId("stay-lightbox-next"));
    expect(lightbox).toHaveTextContent("3 / 7");
    fireEvent.keyDown(lightbox, { key: "ArrowLeft" });
    expect(lightbox).toHaveTextContent("2 / 7");
    expect(within(lightbox).getByRole("img")).toHaveAttribute("src", PHOTOS[1]);
  });

  it("без фото — чесно «фото джерело не дає»", () => {
    wrap(<StayGallery photos={[]} name="Hotel Aurora" />);
    expect(screen.getByTestId("stay-gallery-empty")).toHaveTextContent("Фото джерело не дає");
  });

  it("ціни продавців підвантажуються самі; номер без назви й реклама позначені", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(RATES)));

    await act(async () => {
      wrap(
        <StayHotelRates query={QUERY} source="scrapedo" stayId="gh-abc" now={NOW.toISOString()} />,
      );
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ source: "scrapedo", stay_id: "gh-abc" });
    const room = screen.getByTestId("stay-room");
    expect(room).toHaveTextContent("Номер на двох — тип номера обираєте в продавця");
    const rows = within(room).getAllByTestId("stay-rate");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByTestId("stay-rate-sponsored")).toHaveTextContent("Реклама");
    expect(within(rows[1]).queryByTestId("stay-rate-sponsored")).toBeNull();
  });
});
