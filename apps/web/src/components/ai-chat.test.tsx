import type { ChatReply, FlightQuery, StayQuery, TripQuery } from "@tickets/shared";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../messages/uk.json";
import { openChat } from "@/lib/ai-events";

import { AIChat, type ChatBodyInput } from "./ai-chat";

const push = vi.fn();
const chats = vi.hoisted(() => ({
  loadChatSync: vi.fn(),
  setChatSync: vi.fn(),
  saveChat: vi.fn(),
  deleteChat: vi.fn(),
}));
vi.mock("@/app/actions/chats", () => chats);
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => window.location.pathname,
}));

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

function renderChat(
  send: Send,
  current?: { flights?: FlightQuery; stays?: StayQuery; trip?: TripQuery },
) {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
      <AIChat
        send={send}
        currentSearch={current?.flights}
        currentStaySearch={current?.stays}
        currentTrip={current?.trip}
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
  compare: [],
  cards: [],
  ...extra,
});

beforeEach(() => {
  chats.loadChatSync.mockResolvedValue({ signedIn: false });
  chats.saveChat.mockResolvedValue(true);
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
      current_trip: null,
      previous_trip: null,
      home_airport: null,
      locale: "uk",
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

  it("модуль 23d: варіант поїздки — картка з окремими цінами перельоту й житла, текст коротко", async () => {
    const leg = {
      origin: "WAW",
      destination: "LIS",
      departure_at: "2026-12-10T08:00:00+01:00",
      arrival_at: "2026-12-10T11:30:00+00:00",
      stops: 0,
    };
    const trip = {
      kind: "trip",
      key: "t1",
      label: "Оптимальний",
      money_total: 654,
      unknown_parts: 0,
      currency: "EUR",
      check_in: "2026-12-10",
      check_out: "2026-12-13",
      nights: 3,
      prices_cached: false,
      flight: {
        kind: "flight",
        key: "f1",
        airlines: ["TP"],
        outbound: leg,
        inbound: null,
        duration_min: 210,
        stops: 0,
        price: 531,
        currency: "EUR",
        price_status: "live",
        found_at: null,
      },
      stay: {
        kind: "stay",
        key: "s1",
        name: "Nomad Hostel",
        stay_kind: "hostel",
        image_url: null,
        rating: 8.2,
        review_count: 120,
        district: null,
        distance_to_center_km: 1.2,
        price_per_night: 41,
        total_price: 123,
        nights: 3,
        currency: "EUR",
        found_at: null,
      },
      query: {
        origin: "WAW",
        destination: "LIS",
        departure_date: "2026-12-10",
        return_date: "2026-12-13",
        flight: "mock:f1",
        stay: "mock:s1",
      },
    } as unknown as NonNullable<ChatReply["cards"]>[number];
    const long = "Оптимальний варіант поєднує прямий рейс і хостел біля центру. ".repeat(5);
    renderChat(async () => ok(long, { cards: [trip] }));
    choose("Уся поїздка");

    await say("Варшава Лісабон 10–13 грудня");

    const card = await screen.findByTestId("chat-card-trip");
    expect(card).toHaveTextContent("Оптимальний");
    expect(card).toHaveTextContent(/Переліт\s*531\s€/);
    expect(card).toHaveTextContent(/Житло\s*123\s€/);
    expect(within(card).getByTestId("chat-card-total")).toHaveTextContent("654 €");
    expect(within(card).getByRole("link", { name: /Відкрити в планувальнику/ })).toHaveAttribute(
      "href",
      expect.stringMatching(/flight=mock%3Af1.*#your-trip$/),
    );
    // Довгий супровідний текст згорнутий до трьох рядків — «Докладніше» розгортає.
    fireEvent.click(screen.getByRole("button", { name: "Докладніше" }));
    expect(screen.getByRole("button", { name: "Згорнути" })).toBeInTheDocument();
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

  it("команди готової поїздки змінюють стан сторінки: нова конфігурація, назад, порівняння, збереження", async () => {
    const trip = {
      origin: "WAW",
      destination: "LIS",
      departure_date: "2026-12-05",
      return_date: "2026-12-08",
    } as TripQuery;
    // Історія вкладки: попередній крок і поточний.
    sessionStorage.setItem(
      "tickets.tripHistory.v1",
      JSON.stringify([
        "from=WAW&to=LIS&depart=2026-12-05&return=2026-12-08",
        "from=WAW&to=LIS&depart=2026-12-05&return=2026-12-08&flight=mock%3Aa&stay=mock%3Ab",
      ]),
    );
    const changed = { ...trip, flight: "mock:a", stay: "mock:c" } as TripQuery;
    const send = vi
      .fn<Send>()
      .mockResolvedValueOnce(
        ok("Знайшов дешевше житло.", { trip_search: changed as ChatReply["trip_search"] }),
      )
      .mockResolvedValueOnce(ok("Повернув.", { trip_action: "undo" }));
    renderChat(send, { trip });
    choose("Уся поїздка");

    await say("знайди дешевший готель, квитки не змінюй");

    const body = send.mock.calls[0][0];
    expect(body.current_trip).toEqual(trip);
    expect(body.previous_trip).toMatchObject({ origin: "WAW", flight: null, stay: null });
    expect(push).toHaveBeenLastCalledWith(
      "/trip?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-08&stay=mock%3Ac&flight=mock%3Aa",
      { scroll: false },
    );

    await say("поверни попередній варіант");
    expect(push).toHaveBeenLastCalledWith(
      "/trip?from=WAW&to=LIS&depart=2026-12-05&return=2026-12-08",
      {
        scroll: false,
      },
    );
  });

  it("картки результатів: переглянути, перенести в планувальник, вік ціни", async () => {
    const leg = {
      origin: "WAW",
      destination: "LIS",
      departure_at: "2026-12-10T06:10:00+01:00",
      arrival_at: "2026-12-10T09:30:00+00:00",
      stops: 0,
    };
    const flight = {
      kind: "flight" as const,
      key: "mock:abc",
      label: "Найдешевший",
      airlines: ["LOT"],
      outbound: leg,
      inbound: {
        ...leg,
        origin: "LIS",
        destination: "WAW",
        departure_at: "2026-12-14T10:00:00+00:00",
      },
      duration_min: 400,
      stops: 0,
      price: 230,
      currency: "EUR",
      price_status: "cached" as const,
      found_at: "2020-01-01T00:00:00Z",
    };
    const send = vi
      .fn<Send>()
      .mockResolvedValueOnce(ok("Ось варіанти.", { search: SEARCH, cards: [flight] }));
    renderChat(send);
    choose("Квитки");

    await say("Варшава — Лісабон 10 грудня");

    const card = screen.getByTestId("chat-card-flight");
    expect(card).toHaveTextContent("Найдешевший");
    expect(card).toHaveTextContent("WAW → LIS");
    expect(card).toHaveTextContent("LOT");
    expect(card).toHaveTextContent(/230\s€/);
    expect(screen.getByTestId("chat-card-age").className).toContain("warning"); // застаріла
    const links = within(card).getAllByRole("link");
    expect(links[0].getAttribute("href")).toContain("#offer-mock-abc");
    const plan = new URLSearchParams(links[1].getAttribute("href")!.split("?")[1]);
    expect(Object.fromEntries(plan)).toMatchObject({
      from: "WAW",
      to: "LIS",
      depart: "2026-12-10",
      return: "2026-12-14",
      flight: "mock:abc",
    });
  });

  it("«Оптимізувати з ШІ» з планувальника відкриває нову розмову «Уся поїздка» з чернеткою", async () => {
    renderChat(vi.fn<Send>());
    act(() => openChat({ mode: "trip", draft: "Оптимізуй цю поїздку" }));

    expect(screen.getByText("Розмова: Уся поїздка")).toBeInTheDocument();
    expect(screen.getByLabelText("Запитайте ШІ-помічника")).toHaveValue("Оптимізуй цю поїздку");
  });

  it("історія: перейменування; синхронізація лише за згодою — злиття, вивантаження, видалення", async () => {
    chats.loadChatSync.mockResolvedValue({
      signedIn: true,
      enabled: true,
      conversations: [
        {
          id: "remote-conv-1",
          mode: "stays",
          title: "З іншого пристрою",
          created_at: 1,
          updated_at: 5,
          turns: [{ role: "user", text: "Житло в Римі" }],
        },
      ],
    });
    const send = vi.fn<Send>().mockResolvedValueOnce(ok("Звідки летите?"));
    renderChat(send);
    await act(async () => {});
    choose("Квитки");
    await say("Хочу в Лісабон");

    // Нова розмова пішла в акаунт; розмова з іншого пристрою — в історії.
    expect(chats.saveChat).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ mode: "flights", title: "Хочу в Лісабон" }),
    );
    click(/Історія/);
    expect(screen.getByText("З іншого пристрою")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Перейменувати розмову «Хочу в Лісабон»" }));
    fireEvent.change(screen.getByLabelText("Назва розмови"), {
      target: { value: "Лісабон у грудні" },
    });
    click("Готово");
    expect(screen.getByText("Лісабон у грудні")).toBeInTheDocument();
    expect(chats.saveChat).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ title: "Лісабон у грудні" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Видалити розмову «З іншого пристрою»" }));
    expect(chats.deleteChat).toHaveBeenCalledWith("remote-conv-1");

    chats.setChatSync.mockResolvedValue({ signedIn: true, enabled: false, conversations: [] });
    await act(async () =>
      fireEvent.click(screen.getByRole("checkbox", { name: /Синхронізувати/ })),
    );
    expect(chats.setChatSync).toHaveBeenCalledWith(false);
    expect(screen.getByTestId("chat-sync")).toHaveTextContent("Вимкнено");
  });

  it("гість: розмови лише в браузері, на сервер нічого", async () => {
    renderChat(vi.fn<Send>().mockResolvedValueOnce(ok("Звідки летите?")));
    await act(async () => {});
    choose("Квитки");
    await say("Хочу в Лісабон");
    click(/Історія/);

    expect(chats.saveChat).not.toHaveBeenCalled();
    expect(screen.getByText(/Увійдіть, щоб синхронізувати/)).toBeInTheDocument();
  });
});
