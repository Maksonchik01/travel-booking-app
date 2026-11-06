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
  passengers: { adults: 1, children: 0, infants: 0 },
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
  guests: { adults: 2, children: 0 },
  currency: "EUR",
  profile: "balanced",
  filters: { free_cancellation: false },
};

type Send = (body: ChatBodyInput) => Promise<ChatReply | null>;

function renderChat(send: Send, current?: { flights?: FlightQuery; stays?: StayQuery }) {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages}>
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

async function say(text: string) {
  fireEvent.change(screen.getByLabelText("Запитайте ШІ-помічника"), { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Надіслати" }));
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

beforeEach(() => {
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
    expect(screen.getByRole("button", { name: /^Житло/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("кожна репліка йде з усією розмовою свого режиму; квитки відкриваються сторінкою", async () => {
    const send = vi
      .fn<Send>()
      .mockResolvedValueOnce({ status: "ok", reply: "Звідки летите?", search: null })
      .mockResolvedValueOnce({ status: "ok", reply: "Прямий — 88 EUR.", search: SEARCH });
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
    expect(bubbles()).toEqual([
      "Ви: Хочу в Лісабон 10 грудня",
      "Помічник: Звідки летите?",
      "Ви: з Варшави, прямі",
      "Помічник: Прямий — 88 EUR.",
    ]);
    expect(push).toHaveBeenCalledWith("/?from=WAW&to=LIS&depart=2026-12-10&direct=1");
  });

  it("квитки й житло — окремі розмови, що не змішуються", async () => {
    const send = vi.fn<Send>(async (body) => ({
      status: "ok",
      reply: body.mode === "stays" ? "Ось житло." : "Ось квитки.",
      search: null,
    }));
    renderChat(send, { stays: STAY });
    choose("Квитки");
    await say("Квитки в Лісабон");

    fireEvent.click(screen.getByRole("button", { name: /^Житло/ }));
    expect(bubbles()).toEqual([]);
    await say("а ближче до центру?");

    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mode: "stays",
        messages: [{ role: "user", text: "а ближче до центру?" }],
        current_stay_search: STAY,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Квитки/ }));
    expect(bubbles()).toEqual(["Ви: Квитки в Лісабон", "Помічник: Ось квитки."]);
  });

  it("уся поїздка — посилання і на квитки, і на житло, без переходу", async () => {
    renderChat(async () => ({
      status: "ok",
      reply: "Переліт і житло знайдено.",
      search: SEARCH,
      stay_search: STAY,
    }));
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

  it("розмова переживає перехід між сторінками; «Нова розмова» стирає лише свою", async () => {
    const send = vi.fn<Send>(async () => ({ status: "ok", reply: "Куди летите?", search: null }));
    const first = renderChat(send);
    choose("Квитки");
    await say("Привіт");
    first.unmount();

    renderChat(send);
    expect(bubbles()).toEqual(["Ви: Привіт", "Помічник: Куди летите?"]);

    fireEvent.click(screen.getByRole("button", { name: "Нова розмова" }));
    expect(bubbles()).toEqual([]);
  });

  it("помічник недоступний — повідомлення повертається в поле", async () => {
    renderChat(async () => null);
    choose("Квитки");

    await say("Лісабон у грудні");

    expect(screen.getByRole("alert")).toHaveTextContent("скористайтеся формою");
    expect(screen.getByLabelText("Запитайте ШІ-помічника")).toHaveValue("Лісабон у грудні");
    expect(bubbles()).toEqual([]);
  });
});
