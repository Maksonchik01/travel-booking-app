import { act, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../messages/uk.json";
import { focusStayOnMap } from "../lib/map-events";
import { parseStayParams, toStayParams } from "../lib/stay-params";
import { type MapStay, StayMap } from "./stay-map";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));

// WebGL у jsdom немає — підміняємо maplibre мінімальною картою, що вміє маркери й події.
const handlers: Record<string, (e: unknown) => void> = {};
const bounds = {
  getSouth: () => 38.7,
  getWest: () => -9.2,
  getNorth: () => 38.76,
  getEast: () => -9.1,
};
vi.mock("maplibre-gl", () => {
  class FakeMap {
    container: HTMLElement;
    constructor({ container }: { container: HTMLElement }) {
      this.container = container;
    }
    addControl() {}
    fitBounds() {}
    flyTo = vi.fn();
    getZoom = () => 12;
    resize() {}
    remove() {}
    getBounds = () => bounds;
    on(event: string, cb: (e: unknown) => void) {
      handlers[event] = cb;
    }
  }
  class Marker {
    el: HTMLElement;
    constructor({ element }: { element: HTMLElement }) {
      this.el = element;
    }
    setLngLat() {
      return this;
    }
    addTo(map: FakeMap) {
      map.container.appendChild(this.el);
      return this;
    }
    getElement() {
      return this.el;
    }
    remove() {
      this.el.remove();
    }
  }
  class LngLatBounds {
    extend() {}
  }
  return { Map: FakeMap, Marker, LngLatBounds, NavigationControl: class {}, setWorkerUrl: vi.fn() };
});

globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const STAYS: MapStay[] = [
  {
    key: "mock:1",
    anchor: "stay-mock-1",
    name: "Hotel A",
    lat: 38.72,
    lon: -9.14,
    price: 120,
    currency: "EUR",
    rating: 8.4,
  },
  {
    key: "mock:2",
    anchor: "stay-mock-2",
    name: "Hostel B",
    lat: 38.71,
    lon: -9.13,
    price: 40,
    currency: "EUR",
    rating: null,
  },
];

async function renderMap() {
  render(
    <NextIntlClientProvider locale="uk" messages={messages}>
      <StayMap
        stays={STAYS}
        withoutCoordinates={1}
        baseParams="city=LIS&in=2026-12-05&out=2026-12-08"
        listHref="/stays?city=LIS"
      />
    </NextIntlClientProvider>,
  );
  await screen.findAllByTestId("stay-marker");
}

describe("StayMap", () => {
  beforeEach(() => push.mockClear());

  it("маркери з цінами; вибір — коротка картка з «Детальніше»; без координат — підпис", async () => {
    await renderMap();
    const markers = screen.getAllByTestId("stay-marker");
    // Між числом і валютою — нерозривний пробіл (Intl), порівнюємо з звичайним.
    expect(markers.map((m) => m.textContent?.replace(/\s/g, " "))).toEqual(["120 €", "40 €"]);
    expect(screen.getByText(/1 варіант без точних координат не показано/)).toBeInTheDocument();

    fireEvent.click(markers[1]);
    const card = screen.getByTestId("stay-map-card");
    expect(card).toHaveTextContent("Hostel B");
    expect(screen.getByRole("link", { name: /Детальніше/ })).toHaveAttribute(
      "href",
      "/stays?city=LIS#stay-mock-2",
    );
    expect(markers[1].style.background).toBe("var(--primary)");
  });

  it("«На карті» зі списку вибирає маркер; «Шукати в цій області» — після руху людини", async () => {
    await renderMap();
    act(() => focusStayOnMap("mock:1"));
    expect(screen.getByTestId("stay-map-card")).toHaveTextContent("Hotel A");

    act(() => handlers.moveend?.({})); // програмний рух — кнопки немає
    expect(screen.queryByRole("button", { name: "Шукати в цій області" })).toBeNull();
    act(() => handlers.moveend?.({ originalEvent: {} }));
    fireEvent.click(screen.getByRole("button", { name: "Шукати в цій області" }));
    expect(push).toHaveBeenCalledWith(
      "/stays?city=LIS&in=2026-12-05&out=2026-12-08&bbox=38.7000%2C-9.2000%2C38.7600%2C-9.1000&view=map",
      { scroll: false },
    );
  });
});

describe("bbox і режим у URL житла", () => {
  it("область і карта переживають URL; биті межі — без області", () => {
    const state = parseStayParams({
      city: "LIS",
      in: "2026-12-05",
      out: "2026-12-08",
      bbox: "38.7,-9.2,38.76,-9.1",
      view: "map",
    })!;
    expect(state.query.filters?.bbox).toEqual({
      south: 38.7,
      west: -9.2,
      north: 38.76,
      east: -9.1,
    });
    expect(state.view).toBe("map");
    expect(toStayParams(state).get("bbox")).toBe("38.7000,-9.2000,38.7600,-9.1000");
    expect(
      parseStayParams({ city: "LIS", in: "2026-12-05", out: "2026-12-08", bbox: "40,0,39,1" })
        ?.query.filters?.bbox,
    ).toBeNull();
  });
});
