import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import messages from "../../messages/uk.json";
import { SearchForm } from "./search-form";

vi.mock("next/form", () => ({
  default: (props: React.FormHTMLAttributes<HTMLFormElement>) => <form {...props} />,
}));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

function hiddenFilters(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLInputElement>("input[type=hidden]")]
    .filter((i) => ["stops", "dep"].includes(i.name))
    .map((i) => `${i.name}=${i.value}`);
}

describe("SearchForm: збережені фільтри", () => {
  it("додаються до нового пошуку, поки позначку не знято", () => {
    const { container } = render(
      <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
        <SearchForm initial={null} savedFilters="stops=0&dep=morning" />
      </NextIntlClientProvider>,
    );

    const toggle = screen.getByRole("checkbox", { name: "Застосувати збережені фільтри (2)" });
    expect(toggle).toBeChecked();
    expect(hiddenFilters(container)).toEqual(["stops=0", "dep=morning"]);

    fireEvent.click(toggle);
    expect(hiddenFilters(container)).toEqual([]);
  });

  it("без збережених — без позначки", () => {
    render(
      <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
        <SearchForm initial={null} />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByRole("checkbox", { name: /збережені фільтри/ })).toBeNull();
  });
});

describe("SearchForm: «Будь-куди» (ADR 0045)", () => {
  it("відкриває Explore з уже введеними звідки й датами", () => {
    const { container } = render(
      <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
        <SearchForm initial={null} />
      </NextIntlClientProvider>,
    );
    const set = (name: string, value: string) => {
      const input = container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
      fireEvent.change(input, { target: { value } });
    };
    // Місце — у видиме поле (код потрапляє в приховане).
    fireEvent.change(container.querySelector<HTMLInputElement>("#from")!, {
      target: { value: "WAW" },
    });
    set("depart", "2026-12-05");
    set("return", "2026-12-08");

    fireEvent.click(screen.getByTestId("search-anywhere"));

    expect(push).toHaveBeenCalledWith("/explore?from=WAW&depart=2026-12-05&return=2026-12-08");
  });
});

describe("SearchForm: швидкі дати (модуль 3)", () => {
  function form() {
    return render(
      <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
        <SearchForm initial={null} />
      </NextIntlClientProvider>,
    );
  }
  const value = (container: HTMLElement, name: string) =>
    container.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)?.value;

  it("вихідні місяця — увесь місяць, 1–3 ночі, «лише вихідні»; від обраної дати", () => {
    const { container } = form();
    fireEvent.change(container.querySelector("#depart")!, { target: { value: "2027-02-14" } });

    fireEvent.click(screen.getByTestId("preset-monthWeekends"));

    expect(value(container, "depart")).toBe("2027-02-01");
    expect(value(container, "flex")).toBe("month");
    expect([value(container, "nmin"), value(container, "nmax")]).toEqual(["1", "3"]);
    expect(container.querySelector<HTMLInputElement>('[name="wk"]')!.checked).toBe(true);
  });

  it("5–7 днів — свій період і 4–6 ночей; вихідні — точні дати", () => {
    const { container } = form();
    fireEvent.change(container.querySelector("#depart")!, { target: { value: "2027-03-01" } });

    fireEvent.click(screen.getByTestId("preset-week"));
    expect(value(container, "flex")).toBe("range");
    expect(value(container, "until")).toBe("2027-03-31");
    expect([value(container, "nmin"), value(container, "nmax")]).toEqual(["4", "6"]);
    expect(container.querySelector<HTMLInputElement>('[name="wk"]')!.checked).toBe(false);

    fireEvent.click(screen.getByTestId("preset-nextWeekend"));
    expect(value(container, "flex")).toBe("0");
    expect(container.querySelector('[name="nmin"]')).toBeNull();
    const depart = new Date(`${value(container, "depart")}T00:00:00Z`);
    const back = new Date(`${value(container, "return")}T00:00:00Z`);
    expect([depart.getUTCDay(), back.getUTCDay()]).toEqual([5, 0]);
  });
});
