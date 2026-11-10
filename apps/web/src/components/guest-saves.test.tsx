import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../messages/uk.json";
import { readGuestSearches, saveGuestSearch } from "@/lib/guest-searches";
import type { SavedTripItem } from "@/lib/saved-trips";

import { GuestImportPrompt } from "./guest-import";
import { SavedTripsProvider, TripChecklist } from "./saved-trips";

const guest = vi.hoisted(() => ({ importGuestData: vi.fn() }));
vi.mock("@/app/actions/guest-import", () => guest);
const trips = vi.hoisted(() => ({
  loadSavedTrips: vi.fn(),
  createSavedTrip: vi.fn(),
  updateSavedTrip: vi.fn(),
  patchSavedTrip: vi.fn(),
  setTripSharing: vi.fn(),
  setTripChecklist: vi.fn(),
  deleteSavedTrip: vi.fn(),
}));
vi.mock("@/app/actions/saved-trips", () => trips);

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>,
  );
}

const TRIP = {
  id: "local-1",
  title: "Лісабон",
  created_at: "2026-11-10T10:00:00Z",
  updated_at: "2026-11-10T10:00:00Z",
  query: { origin: "WAW", destination: "LIS", departure_date: "2026-12-05" },
  snapshot: { money_total: 500 },
} as unknown as SavedTripItem;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
});

describe("збереження гостя й перенесення (етап 7)", () => {
  it("пошук гостя — у браузері, без дублікатів", () => {
    expect(saveGuestSearch({ kind: "explore", params: "from=AMS", title: "AMS" })).toBe(true);
    expect(saveGuestSearch({ kind: "explore", params: "from=AMS", title: "AMS ще раз" })).toBe(
      true,
    );
    expect(readGuestSearches()).toHaveLength(1);
  });

  it("після входу — пропозиція з кількістю; «Перенести» надсилає все й чистить браузер", async () => {
    localStorage.setItem("tickets.savedTrips.v1", JSON.stringify([TRIP]));
    saveGuestSearch({ kind: "flights", params: "from=WAW&to=LIS", title: "WAW → LIS" });
    guest.importGuestData.mockResolvedValue({ ok: true, signedIn: true });
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });

    await act(async () => {
      wrap(<GuestImportPrompt />);
    });
    const prompt = screen.getByTestId("guest-import");
    expect(prompt).toHaveTextContent("обраного — 0, поїздок — 1, пошуків — 1");

    await act(async () => fireEvent.click(screen.getByTestId("guest-import-move")));

    const sent = guest.importGuestData.mock.calls[0][0];
    expect(sent.trips).toHaveLength(1);
    expect(sent.searches[0].params).toBe("from=WAW&to=LIS");
    expect(localStorage.getItem("tickets.savedTrips.v1")).toBeNull();
    expect(readGuestSearches()).toEqual([]);
    expect(reload).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("збій перенесення — локальне лишається; «Не зараз» ховає до кінця сесії", async () => {
    saveGuestSearch({ kind: "stays", params: "city=LIS", title: "LIS" });
    guest.importGuestData.mockResolvedValue({ ok: false, signedIn: true });

    const { unmount } = await act(async () => wrap(<GuestImportPrompt />));
    await act(async () => fireEvent.click(screen.getByTestId("guest-import-move")));
    expect(screen.getByRole("alert")).toHaveTextContent("Не вдалося перенести");
    expect(readGuestSearches()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Не зараз" }));
    expect(screen.queryByTestId("guest-import")).toBeNull();
    unmount();
    await act(async () => {
      wrap(<GuestImportPrompt />);
    });
    expect(screen.queryByTestId("guest-import")).toBeNull();
  });
});

describe("чекліст поїздки (етап 7)", () => {
  it("стандартні пункти; виконати, додати власний, змінити, видалити — гість у браузері", async () => {
    localStorage.setItem("tickets.savedTrips.v1", JSON.stringify([TRIP]));
    trips.loadSavedTrips.mockResolvedValue({ signedIn: false });

    await act(async () => {
      wrap(
        <SavedTripsProvider>
          <TripChecklist item={TRIP} />
        </SavedTripsProvider>,
      );
    });
    const box = screen.getByTestId("trip-checklist");
    expect(within(box).getAllByTestId("checklist-item")).toHaveLength(5);
    expect(box).toHaveTextContent("Чекліст подорожі · 0 з 5");

    await act(async () => fireEvent.click(screen.getByRole("checkbox", { name: /Документи/ })));
    const stored = () =>
      (JSON.parse(localStorage.getItem("tickets.savedTrips.v1")!) as SavedTripItem[])[0].checklist!;
    expect(stored().find((i) => i.key === "documents")?.done).toBe(true);

    fireEvent.change(screen.getByLabelText("Новий пункт чекліста"), {
      target: { value: "Адаптер для розетки" },
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Додати" })));
    expect(stored().at(-1)).toMatchObject({ key: null, text: "Адаптер для розетки", done: false });

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Видалити «Багаж»" })),
    );
    expect(stored().some((i) => i.key === "baggage")).toBe(false);
    expect(trips.setTripChecklist).not.toHaveBeenCalled(); // гість — без запитів до API
  });
});
