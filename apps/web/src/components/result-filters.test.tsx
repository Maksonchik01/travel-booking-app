import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import messages from "../../messages/uk.json";
import { ProviderAlerts } from "./provider-alerts";
import { ResultFilters } from "./result-filters";

vi.mock("next/form", () => ({
  default: (props: React.FormHTMLAttributes<HTMLFormElement>) => <form {...props} />,
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
    expect(screen.getByRole("checkbox", { name: /Ранок/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Ryanair/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /W6/ })).not.toBeChecked(); // без назви — код
    // Обрана, але відсутня у видачі авіакомпанія лишається, щоб її можна було зняти.
    expect(screen.getByRole("checkbox", { name: /U2/ })).toBeChecked();
    const hidden = [...container.querySelectorAll<HTMLInputElement>("input[type=hidden]")].map(
      (i) => `${i.name}=${i.value}`,
    );
    expect(hidden).toEqual(["from=WAW", "sort=score"]);
    expect(screen.getByRole("link", { name: "Скинути фільтри" })).toHaveAttribute(
      "href",
      "/?from=WAW&sort=score",
    );
  });

  it("без активних фільтрів — без «скинути»", () => {
    wrap(<ResultFilters filters={{}} airlines={[]} baseParams={[]} />);

    expect(screen.getByRole("radio", { name: "Будь-яка кількість" })).toBeChecked();
    expect(screen.queryByRole("link", { name: "Скинути фільтри" })).toBeNull();
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
