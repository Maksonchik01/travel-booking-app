import type { Place } from "@tickets/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import messages from "../../messages/uk.json";
import { codeFromText, PlaceInput, type PlaceValue, placeLabel, placeValue } from "./place-input";

const LONDON: Place = {
  code: "LON",
  kind: "city",
  name: "Лондон",
  city_name: "Лондон",
  country_name: "Велика Британія",
  airports: ["LGW", "LHR"],
};
const HEATHROW: Place = {
  ...LONDON,
  code: "LHR",
  kind: "airport",
  name: "Хітроу",
  airports: ["LHR"],
};
const WARSAW: Place = {
  code: "WAW",
  kind: "airport",
  name: "Фредерік Шопен",
  city_name: "Варшава",
  country_name: "Польща",
  airports: ["WAW"],
};

function setup(initial: PlaceValue, places: Place[]) {
  const load = vi.fn(async () => places);
  let current = initial;
  function Harness() {
    const [value, setValue] = useState(initial);
    current = value;
    return (
      <form aria-label="f">
        <PlaceInput
          id="from"
          name="from"
          value={value}
          onChange={setValue}
          placeholder=""
          loadPlaces={load}
        />
      </form>
    );
  }
  render(
    <NextIntlClientProvider locale="uk" messages={messages}>
      <Harness />
    </NextIntlClientProvider>,
  );
  return { load, value: () => current, input: screen.getByRole("combobox") };
}

async function typeAndWait(input: HTMLElement, text: string) {
  vi.useFakeTimers();
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: text } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  vi.useRealTimers();
}

describe("placeLabel", () => {
  it("місто — «усі аеропорти», аеропорт — місто й назва без повтору", () => {
    expect(placeLabel(LONDON, "усі аеропорти")).toBe("Лондон — усі аеропорти");
    expect(placeLabel(HEATHROW, "")).toBe("Лондон, Хітроу");
    expect(placeLabel({ ...HEATHROW, name: "Лондон" }, "")).toBe("Лондон");
    // Житло: лише місто, без «усі аеропорти» і назв аеропортів.
    expect(placeLabel(LONDON, "усі аеропорти", "city")).toBe("Лондон");
    expect(placeLabel({ ...WARSAW, kind: "city", name: "Варшава" }, "", "city")).toBe("Варшава");
  });

  it("код з ручного введення — лише 3 латинські літери", () => {
    expect(codeFromText(" waw ")).toBe("WAW");
    expect(codeFromText("вар")).toBe("");
    expect(codeFromText("WAWA")).toBe("");
  });
});

describe("PlaceInput", () => {
  it("підказує і вибирає місце клавіатурою; форма отримує код", async () => {
    const { input, load, value } = setup(placeValue(undefined), [LONDON, HEATHROW]);

    await typeAndWait(input, "лон");

    expect(load).toHaveBeenCalledWith("лон", expect.any(AbortSignal));
    expect(input).toHaveAttribute("aria-expanded", "true");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(value()).toEqual({ code: "LHR", label: "Лондон, Хітроу", picked: true });
    expect(input).toHaveValue("Лондон, Хітроу");
    expect(input).toHaveAttribute("aria-expanded", "false");
    const hidden = screen.getByRole("form").querySelector('input[type="hidden"][name="from"]');
    expect(hidden).toHaveValue("LHR");
    expect(input).not.toHaveAttribute("name");
  });

  it("код з URL показує назвою", async () => {
    const { input } = setup(placeValue("WAW"), [WARSAW]);

    await act(async () => {});

    expect(input).toHaveValue("Варшава, Фредерік Шопен");
  });

  it("назва без вибору зі списку — форма невалідна; код вручну — валідна", async () => {
    const { input } = setup(placeValue(undefined), []);

    fireEvent.change(input, { target: { value: "варш" } });
    expect((input as HTMLInputElement).validity.customError).toBe(true);

    fireEvent.change(input, { target: { value: "waw" } });
    expect((input as HTMLInputElement).validity.customError).toBe(false);
  });
});

describe("PlaceInput: порожньо й помилка (13.2)", () => {
  it("нічого не знайдено — підказка про код IATA", async () => {
    const { input } = setup(placeValue(""), []);
    await typeAndWait(input, "Атлантида");
    expect(screen.getByTestId("places-miss")).toHaveTextContent("Нічого не знайдено");
  });

  it("джерело недоступне — інша підказка, а не «нічого»", async () => {
    const { input, load } = setup(placeValue(""), []);
    load.mockRejectedValueOnce(new Error("down"));
    await typeAndWait(input, "Лон");
    expect(screen.getByTestId("places-miss")).toHaveTextContent("Підказки зараз недоступні");
  });
});
