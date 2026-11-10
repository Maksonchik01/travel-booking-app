import { act, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../messages/uk.json";
import { openChat } from "@/lib/ai-events";
import { CHAT_OPEN_ATTR, SEARCH_AREA_ATTR, SELECT_TAB_EVENT, SearchTabs } from "./search-tabs";

let search = "from=WAW&to=LIS";
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(search),
}));

function setWide(wide: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: wide, addEventListener() {}, removeEventListener() {} })),
  );
}

function ui() {
  return (
    <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
      <div {...{ [SEARCH_AREA_ATTR]: "" }} data-testid="area">
        <SearchTabs form={<form>форма</form>} chat={<textarea aria-label="повідомлення" />} />
      </div>
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  search = "from=WAW&to=LIS";
  setWide(false);
});
afterEach(() => vi.unstubAllGlobals());

describe("SearchTabs: ШІ-помічник не заважає результатам (модуль 23a)", () => {
  it("за замовчуванням згорнутий: форма на місці, лише кнопка «ШІ-помічник»", () => {
    render(ui());

    expect(screen.getByTestId("search-panel-form")).toBeVisible();
    expect(screen.getByTestId("search-panel-chat")).not.toBeVisible();
    expect(screen.getByTestId("chat-launcher")).toHaveTextContent("ШІ-помічник");
  });

  it("кнопка відкриває панель із фокусом у полі; «Згорнути» й Escape — назад до кнопки", () => {
    render(ui());

    fireEvent.click(screen.getByTestId("chat-launcher"));
    expect(screen.getByTestId("search-panel-chat")).toBeVisible();
    expect(screen.getByLabelText("повідомлення")).toHaveFocus();
    expect(document.documentElement.hasAttribute(CHAT_OPEN_ATTR)).toBe(true);
    expect(screen.queryByTestId("chat-launcher")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Згорнути помічника" }));
    expect(screen.getByTestId("search-panel-chat")).not.toBeVisible();
    expect(document.documentElement.hasAttribute(CHAT_OPEN_ATTR)).toBe(false);

    fireEvent.click(screen.getByTestId("chat-launcher"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("search-panel-chat")).not.toBeVisible();
  });

  it("«ШІ-пошук» у перемикачі режимів і «Оптимізувати з ШІ» відкривають панель", () => {
    render(ui());

    act(() => {
      screen
        .getByTestId("area")
        .dispatchEvent(new CustomEvent(SELECT_TAB_EVENT, { detail: "chat" }));
    });
    expect(screen.getByTestId("search-panel-chat")).toBeVisible();

    act(() => {
      screen
        .getByTestId("area")
        .dispatchEvent(new CustomEvent(SELECT_TAB_EVENT, { detail: "form" }));
    });
    expect(screen.getByTestId("search-panel-chat")).not.toBeVisible();

    act(() => openChat({ mode: "trip", draft: "" }));
    expect(screen.getByTestId("search-panel-chat")).toBeVisible();
  });

  it("на телефоні нові результати згортають шторку; на широкому екрані панель лишається", () => {
    const { rerender } = render(ui());
    fireEvent.click(screen.getByTestId("chat-launcher"));

    search = "from=WAW&to=BCN";
    rerender(ui());
    expect(screen.getByTestId("search-panel-chat")).not.toBeVisible();

    setWide(true);
    fireEvent.click(screen.getByTestId("chat-launcher"));
    search = "from=WAW&to=MAD";
    rerender(ui());
    expect(screen.getByTestId("search-panel-chat")).toBeVisible();
  });
});
