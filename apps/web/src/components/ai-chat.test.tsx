import type { ChatReply, FlightQuery } from "@tickets/shared";
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

function renderChat(
  send: (body: ChatBodyInput) => Promise<ChatReply | null>,
  current?: FlightQuery,
) {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages}>
      <AIChat send={send} currentSearch={current} homeAirport={current?.origin} />
    </NextIntlClientProvider>,
  );
}

async function say(text: string) {
  fireEvent.change(screen.getByLabelText("Запитайте ШІ-помічника"), { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Надіслати" }));
  });
}

function bubbles() {
  return screen.queryAllByRole("listitem").map((li) => li.textContent);
}

beforeEach(() => {
  sessionStorage.clear();
  push.mockClear();
});

describe("AIChat", () => {
  it("кожна репліка йде з усією розмовою; знайдене відкривається сторінкою результатів", async () => {
    const send = vi
      .fn<(body: ChatBodyInput) => Promise<ChatReply | null>>()
      .mockResolvedValueOnce({ status: "ok", reply: "Звідки летите?", search: null })
      .mockResolvedValueOnce({ status: "ok", reply: "Прямий — 88 EUR.", search: SEARCH });
    renderChat(send);

    await say("Хочу в Лісабон 10 грудня");
    await say("з Варшави, прямі");

    expect(send).toHaveBeenLastCalledWith({
      messages: [
        { role: "user", text: "Хочу в Лісабон 10 грудня" },
        { role: "assistant", text: "Звідки летите?" },
        { role: "user", text: "з Варшави, прямі" },
      ],
      current_search: null,
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

  it("передає поточний пошук зі сторінки — «а прямі?» стосується його", async () => {
    const send = vi.fn(async () => ({ status: "ok" as const, reply: "Ось прямі.", search: null }));
    renderChat(send, SEARCH);

    await say("а прямі?");

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ current_search: SEARCH, home_airport: "WAW" }),
    );
  });

  it("розмова переживає перехід між сторінками в межах вкладки; «Нова розмова» її стирає", async () => {
    const send = vi.fn(async () => ({
      status: "ok" as const,
      reply: "Куди летите?",
      search: null,
    }));
    const first = renderChat(send);
    await say("Привіт");
    first.unmount();

    renderChat(send);
    expect(bubbles()).toEqual(["Ви: Привіт", "Помічник: Куди летите?"]);

    fireEvent.click(screen.getByRole("button", { name: "Нова розмова" }));
    expect(bubbles()).toEqual([]);
    expect(sessionStorage.length).toBe(0);
  });

  it("помічник недоступний — повідомлення повертається в поле, розмова без змін", async () => {
    renderChat(async () => null);

    await say("Лісабон у грудні");

    expect(screen.getByRole("alert")).toHaveTextContent("скористайтеся формою");
    expect(screen.getByLabelText("Запитайте ШІ-помічника")).toHaveValue("Лісабон у грудні");
    expect(bubbles()).toEqual([]);
  });

  it("відповідь не пройшла перевірку чисел — свій текст, але результати відкриваються", async () => {
    renderChat(async () => ({ status: "fallback", reply: null, search: SEARCH }));

    await say("Варшава Лісабон 10 грудня");

    expect(bubbles().at(-1)).toContain("варіанти й оцінку дивіться нижче");
    expect(push).toHaveBeenCalled();
  });
});
