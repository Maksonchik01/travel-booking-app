import { fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import messages from "../../messages/uk.json";
import { ProviderAlerts } from "./provider-alerts";
import { ResultFilters } from "./result-filters";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const saveFlightFilters = vi.fn(async (filters: string | null) => ({ saved: false, filters }));
vi.mock("@/app/actions/account", () => ({
  saveFlightFilters: (filters: string | null) => saveFlightFilters(filters),
}));

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("ResultFilters", () => {
  it("показує стан фільтрів з URL і зберігає решту пошуку прихованими полями", () => {
    const { container } = wrap(
      <ResultFilters
        filters={{ max_stops: 0, airlines: ["FR", "U2"], departure_periods: ["morning"] }}
        airlines={[
          { code: "FR", name: "Ryanair", offers: 3 },
          { code: "W6", name: null, offers: 1 },
        ]}
        baseParams={[
          ["from", "WAW"],
          ["sort", "score"],
        ]}
      />,
    );

    expect(screen.getByRole("radio", { name: "Лише прямі" })).toBeChecked();
    // Перша група «Ранок» — виліт туди; ще одна така ж — приліт туди.
    expect(screen.getAllByRole("checkbox", { name: /Ранок/ })[0]).toBeChecked();
    const only = within(screen.getByRole("group", { name: /^Авіакомпанії/ }));
    expect(only.getByRole("checkbox", { name: /Ryanair/ })).toBeChecked();
    expect(only.getByRole("checkbox", { name: /W6/ })).not.toBeChecked(); // без назви — код
    // Обрана, але відсутня у видачі авіакомпанія лишається, щоб її можна було зняти.
    expect(only.getByRole("checkbox", { name: /U2/ })).toBeChecked();
    // «Крім авіакомпаній» — окрема група з тими самими перевізниками, нічого не обрано.
    const except = within(screen.getByRole("group", { name: /^Крім авіакомпаній/ }));
    expect(except.getByRole("checkbox", { name: /Ryanair/ })).not.toBeChecked();
    // В один бік — без груп часу «назад».
    expect(screen.queryByRole("group", { name: "Виліт назад" })).toBeNull();
    const hidden = [...container.querySelectorAll<HTMLInputElement>("input[type=hidden]")].map(
      (i) => `${i.name}=${i.value}`,
    );
    expect(hidden).toEqual(["from=WAW", "sort=score"]);
    expect(screen.getByRole("link", { name: "Скинути всі" })).toHaveAttribute(
      "href",
      "/?from=WAW&sort=score",
    );
  });

  it("без активних фільтрів — без «скинути»", () => {
    wrap(<ResultFilters filters={{}} airlines={[]} baseParams={[]} />);

    expect(screen.getByRole("radio", { name: "Будь-яка кількість" })).toBeChecked();
    expect(screen.queryByRole("link", { name: "Скинути всі" })).toBeNull();
  });
});

describe("ProviderAlerts", () => {
  it("вичерпану квоту пояснює окремо, з людською назвою джерела", () => {
    wrap(
      <ProviderAlerts
        providers={[
          { provider: "serpapi", status: "rate_limited", error: "quota", results: 0 },
          { provider: "travelpayouts", status: "timeout", error: "timeout", results: 0 },
        ]}
      />,
    );

    const [quota, timeout] = screen.getAllByRole("status");
    expect(quota).toHaveTextContent("Ліміт запитів до «Google Flights» на цей місяць вичерпано");
    expect(timeout).toHaveTextContent("«Aviasales» не відповіло (не встигло відповісти)");
  });
});

describe("ResultFilters: розширені фільтри, застосування, збереження", () => {
  const base: [string, string][] = [
    ["from", "WAW"],
    ["to", "LIS"],
    ["depart", "2026-12-05"],
  ];

  it("лічильники; розширені згорнуті без активних і розгорнуті з ними", () => {
    const { rerender } = wrap(
      <ResultFilters filters={{ max_stops: 1 }} airlines={[]} baseParams={base} />,
    );
    expect(screen.getByTestId("filters-count")).toHaveTextContent("1");
    expect(screen.getByText("Розширені фільтри").closest("details")).not.toHaveAttribute("open");

    rerender(
      <NextIntlClientProvider locale="uk" messages={messages}>
        <ResultFilters
          filters={{ max_stops: 1, arrival_periods: ["night"], min_layover_min: 60 }}
          airlines={[]}
          baseParams={base}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId("filters-count")).toHaveTextContent("3");
    expect(screen.getByTestId("advanced-count")).toHaveTextContent("(2)");
  });

  it("застосування дає чисту адресу без порожніх полів", () => {
    push.mockClear();
    wrap(<ResultFilters filters={{}} airlines={[]} baseParams={base} />);

    fireEvent.click(screen.getByRole("radio", { name: "Лише прямі" }));

    expect(push).toHaveBeenLastCalledWith("/?from=WAW&to=LIS&depart=2026-12-05&stops=0", {
      scroll: false,
    });
  });

  it("«Зберегти налаштування» — лише фільтри, у браузері й профілі", async () => {
    wrap(
      <ResultFilters
        filters={{ max_stops: 0, departure_periods: ["morning"] }}
        airlines={[]}
        baseParams={base}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Зберегти налаштування" }));

    expect(saveFlightFilters).toHaveBeenCalledWith("stops=0&dep=morning");
    expect(localStorage.getItem("tickets.flightFilters.v1")).toBe("stops=0&dep=morning");
    expect(await screen.findByText(/Збережено в цьому браузері/)).toBeInTheDocument();
  });
});
