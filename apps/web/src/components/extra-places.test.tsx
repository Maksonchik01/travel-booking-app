import type { Place } from "@tickets/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import messages from "../../messages/uk.json";

import { ExtraPlaces } from "./extra-places";
import { type PlaceValue, placeValue } from "./place-input";

const PLACES: Place[] = [
  {
    code: "EIN",
    kind: "airport",
    name: "Ейндговен",
    city_name: "Ейндговен",
    country_name: "Нідерланди",
    airports: ["EIN"],
  },
  {
    code: "RTM",
    kind: "airport",
    name: "Роттердам Гаага",
    city_name: "Роттердам",
    country_name: "Нідерланди",
    airports: ["RTM"],
  },
];

async function loadPlaces(q: string): Promise<Place[]> {
  return PLACES.filter((p) => p.code === q.toUpperCase() || p.city_name.startsWith(q));
}

function Harness({ initial }: { initial: string[] }) {
  const [values, setValues] = useState<PlaceValue[]>(initial.map(placeValue));
  return (
    <form data-testid="form">
      <ExtraPlaces
        id="from"
        name="from"
        values={values}
        onChange={setValues}
        exclude={["AMS"]}
        loadPlaces={loadPlaces}
      />
    </form>
  );
}

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>,
  );
}

const codes = () =>
  new FormData(screen.getByTestId("form") as HTMLFormElement).getAll("from").map(String);

describe("ExtraPlaces (модуль 2): кілька аеропортів", () => {
  it("коди з URL — «чипи» з назвами; прибрати один — лишаються інші", async () => {
    await act(async () => {
      wrap(<Harness initial={["RTM", "EIN"]} />);
    });

    const chips = screen.getAllByTestId("extra-place");
    expect(chips.map((c) => c.textContent)).toEqual([
      expect.stringContaining("Роттердам, Роттердам Гаага"),
      expect.stringContaining("Ейндговен"),
    ]);
    expect(codes()).toEqual(["RTM", "EIN"]);

    fireEvent.click(screen.getByRole("button", { name: /Прибрати Роттердам/ }));
    expect(codes()).toEqual(["EIN"]);
  });

  it("додати за кодом чи назвою; уже обраний не додається; не більше трьох додаткових", async () => {
    await act(async () => {
      wrap(<Harness initial={["RTM"]} />);
    });

    fireEvent.click(screen.getByTestId("from-add-airport"));
    const input = screen.getByRole("combobox");
    // Основний аеропорт (AMS) — заборонений; код, уже серед «чипів», — теж.
    fireEvent.change(input, { target: { value: "AMS" } });
    expect(screen.getByRole("button", { name: "Додати" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "RTM" } });
    expect(screen.getByRole("button", { name: "Додати" })).toBeDisabled();

    fireEvent.change(input, { target: { value: "EIN" } });
    fireEvent.click(screen.getByRole("button", { name: "Додати" }));
    expect(codes()).toEqual(["RTM", "EIN"]);

    fireEvent.click(screen.getByTestId("from-add-airport"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "BRU" } });
    fireEvent.click(screen.getByRole("button", { name: "Додати" }));
    expect(codes()).toEqual(["RTM", "EIN", "BRU"]);
    // Разом з основним — уже чотири.
    expect(screen.queryByTestId("from-add-airport")).toBeNull();
  });
});
