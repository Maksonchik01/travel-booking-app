import { act, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it } from "vitest";

import messages from "../../messages/uk.json";
import { THEME_STORAGE_KEY } from "@/lib/theme";
import { ThemeToggle } from "./theme-toggle";

function renderToggle() {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages}>
      <ThemeToggle />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("ThemeToggle", () => {
  it("перемикає темну тему і запам'ятовує вибір", async () => {
    renderToggle();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Увімкнути темну тему" }));
    });

    expect(document.documentElement).toHaveClass("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    // Кнопка тепер пропонує повернути світлу (стежить за класом на <html>).
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Увімкнути світлу тему" }));
    });
    expect(document.documentElement).not.toHaveClass("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });
});
