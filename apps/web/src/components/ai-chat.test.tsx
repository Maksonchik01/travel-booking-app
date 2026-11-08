import type { ChatReply, FlightQuery, StayQuery } from "@tickets/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../messages/uk.json";
import { AIChat, type ChatBodyInput } from "./ai-chat";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const SEARCH: FlightQuery = {
  origin: "WAW",
  destination: "LIS",
  departure_date: "2026-12-10",
  return_date: null,
  flex_days: 0,
  passengers: { adults: 1, children: 0, infants: 0, infants_in_seat: 0 },
  cabin: "economy",
  baggage: "none",
  direct_only: true,
  currency: "EUR",
  profile: "balanced",
  origin_radius_km: 0,
  destination_radius_km: 0,
  filters: {},
};

const STAY: StayQuery = {
  city: "LIS",
  check_in: "2026-12-10",
  check_out: "2026-12-13",
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

type Send = (body: ChatBodyInput) => Promise<ChatReply | "rate_limited" | null>;

function renderChat(send: Send, current?: { flights?: FlightQuery; stays?: StayQuery }) {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
      <AIChat
        send={send}
        currentSearch={current?.flights}
        currentStaySearch={current?.stays}
        homeAirport={current?.flights?.origin}
      />
    </NextIntlClientProvider>,
  );
}

function choose(mode: "Квитки" | "Житло" | "Уся поїздка") {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${mode}`) }));
}

function click(name: string | RegExp) {
  fireEvent.click(screen.getByRole("button", { name }));
}

async function say(text: string) {
  fireEvent.change(screen.getByLabelText("Запитайте ШІ-помічника"), { target: { value: text } });
  await act(async () => {
    click("Надіслати");
  });
}

/** Репліки розмови без локальної підказки режиму (перший пункт). */
function bubbles() {
  return screen
    .queryAllByRole("listitem")
    .filter((li) => li.dataset.role)
    .slice(1)
    .map((li) => li.textContent);
}

const ok = (reply: string, extra: Partial<ChatReply> = {}): ChatReply => ({
  status: "ok",
  reply,
  search: null,
  ...extra,
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  push.mockClear();
});

describe("AIChat", () => {
  it("спершу питає, що шукаємо: квитки, житло чи всю поїздку", () => {
    renderChat(vi.fn());

    expect(screen.getByText("Привіт! Я допоможу з поїздкою. Що шукаємо?")).toBeInTheDocument();
    expect(screen.queryByLabelText("Запитайте ШІ-помічника")).toBeNull();

    choose("Житло");

    expect(screen.getByLabelText("Запитайте ШІ-помічника")).toBeInTheDocument();
    expect(screen.getByText("Розмова: Житло")).toBeInTheDocument();
  });

  it("кожна репліка йде з усією розмовою; квитки відкриваються сторінкою", async () => {
    const send = vi
      .fn<Send>()
      .mockResolvedValueOnce(ok("Звідки летите?"))
      .mockResolvedValueOnce(ok("Прямий — 88 EUR.", { search: SEARCH }));
    renderChat(send);
    choose("Квитки");

    await say("Хочу в Лісабон 10 грудня");
    await say("з Варшави, прямі");

    expect(send).toHaveBeenLastCalledWith({
      messages: [
        { role: "user", text: "Хочу в Лісабон 10 грудня" },
        { role: "assistant", text: "Звідки летите?" },
        { role: "user", text: "з Варшави, прямі" },
      ],
      mode: "flights",
      current_search: null,
      current_stay_search: null,
      home_airport: null,
    });
    expect(bubbles().slice(0, 3)).toEqual([
      "Ви: Хочу в Лісабон 10 грудня",
      "Помічник: Звідки летите?",
      "Ви: з Варшави, прямі",
    ]);
    expect(push).toHaveBeenCalledWith("/?from=WAW&to=LIS&depart=2026-12-10&direct=1");
    // Посилання на знайдене лишається в розмові — з історії можна повернутися до результатів.
    expect(screen.getByRole("link", { name: "Квитки" })).toBeInTheDocument();
  });

  it("історія: розмови зберігаються, до будь-якої можна повернутися, нова — з чистого аркуша", async () => {
    const send = vi.fn<Send>(async (body) =>
      ok(body.mode === "stays" ? "Ось житло." : "Ось квитки."),
    );
    const first = renderChat(send, { stays: STAY });
    choose("Квитки");
    await say("Квитки в Лісабон");

    click("Новий чат");
    choose("Житло");
    expect(bubbles()).toEqual([]);
    await say("Готель у Лісабоні");
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mode: "stays",
        messages: [{ role: "user", text: "Готель у Лісабоні" }],
        current_stay_search: STAY,
      }),
    );
    first.unmount();

    // Інше відкриття сторінки (історія — у localStorage): відкрита остання розмова.
    renderChat(send);
    expect(bubbles()).toEqual(["Ви: Готель у Лісабоні", "Помічник: Ось житло."]);
    click("Історія (2)");
    const list = screen.getByRole("list", { name: "Історія розмов" });
    expect(list).toHaveTextContent("Готель у Лісабоні");
    expect(list).toHaveTextContent("Квитки в Лісабон");

    click(/^Квитки в Лісабон/);
    expect(bubbles()).toEqual(["Ви: Квитки в Лісабон", "Помічник: Ось квитки."]);

    click("Історія (2)");
    click("Видалити розмову «Готель у Лісабоні»");
    expect(screen.getByRole("list", { name: "Історія розмов" })).not.toHaveTextContent(
      "Готель у Лісабоні",
    );
  });

  it("уся поїздка — посилання і на квитки, і на житло, без переходу", async () => {
    renderChat(async () => ok("Переліт і житло знайдено.", { search: SEARCH, stay_search: STAY }));
    choose("Уся поїздка");

    await say("Варшава Лісабон 10–13 грудня");

    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Квитки" })).toHaveAttribute(
      "href",
      "/?from=WAW&to=LIS&depart=2026-12-10&direct=1",
    );
    expect(screen.getByRole("link", { name: "Житло" })).toHaveAttribute(
      "href",
      "/stays?city=LIS&in=2026-12-10&out=2026-12-13",
    );
  });

  it("помічник недоступний — повідомлення повертається в поле", async () => {
    renderChat(async () => null);
    choose("Квитки");

    await say("Лісабон у грудні");

    expect(screen.getByRole("alert")).toHaveTextContent("скористайтеся формою");
    expect(screen.getByLabelText("Запитайте ШІ-помічника")).toHaveValue("Лісабон у грудні");
    expect(bubbles()).toEqual([]);
  });

  it("ліміт за годину — окреме повідомлення, текст лишається в полі", async () => {
    renderChat(async () => "rate_limited");
    choose("Квитки");

    await say("Лісабон у грудні");

    expect(screen.getByRole("alert")).toHaveTextContent("Забагато повідомлень за годину");
    expect(screen.getByLabelText("Запитайте ШІ-помічника")).toHaveValue("Лісабон у грудні");
  });
});
