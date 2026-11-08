import type { StayFacets } from "@tickets/shared";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import messages from "../../messages/uk.json";
import { StayFilters } from "./stay-filters";

vi.mock("next/form", () => ({
  default: (props: React.FormHTMLAttributes<HTMLFormElement>) => <form {...props} />,
}));

const BASE: StayFacets = {
  total_stays: 2,
  kinds: [
    { kind: "hotel", stays: 1 },
    { kind: "other", stays: 1 },
  ],
  min_price_per_night: 80,
  max_price_per_night: 200,
  amenities: [],
  districts: [],
  available: [],
};

function wrap(facets: StayFacets, airports: string[] = []) {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages}>
      <StayFilters
        filters={{
          free_cancellation: false,
          breakfast_included: false,
          no_prepayment: false,
          pay_at_property: false,
        }}
        facets={facets}
        baseParams={[["city", "LIS"]]}
        airports={airports}
        currency="USD"
      />
    </NextIntlClientProvider>,
  );
}

describe("StayFilters: лише фільтри з даними", () => {
  it("джерело не дає умов, рейтингу й розташування — їхніх фільтрів немає", () => {
    wrap(BASE);

    expect(screen.getByText("За ніч, до USD")).toBeInTheDocument(); // ціна є завжди
    expect(screen.getByRole("checkbox", { name: /Інше/ })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Рейтинг" })).toBeNull();
    expect(screen.queryByRole("group", { name: /Умови/ })).toBeNull();
    expect(screen.queryByText("Розширені фільтри")).toBeNull();
  });

  it("є дані — є фільтри: умови, зручності з кількістю, ліжка, район, біля аеропорту", () => {
    wrap(
      {
        ...BASE,
        available: [
          "rating",
          "cancellation",
          "breakfast",
          "prepayment",
          "beds",
          "distance",
          "coordinates",
          "district",
        ],
        amenities: [{ value: "balcony", stays: 1 }],
        districts: [
          { value: "Центр", stays: 1 },
          { value: "Набережна", stays: 1 },
        ],
      },
      ["LIS"],
    );

    expect(screen.getByRole("group", { name: "Рейтинг" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Сніданок включено" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Без передоплати" })).toBeInTheDocument();
    // Оплати на місці джерело не дало — і фільтра немає.
    expect(screen.queryByRole("checkbox", { name: "Оплата на місці" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: /Балкон \/ тераса/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Ліжок, не менше")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Набережна/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Біля аеропорту")).toHaveTextContent("LIS");
  });
});
