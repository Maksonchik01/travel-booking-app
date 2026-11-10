import type { Stay } from "@tickets/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../messages/uk.json";
import { distanceKm } from "@/lib/geo";
import { sortStays } from "@/lib/sort";
import { parseStayParams, toStayParams } from "@/lib/stay-params";

import { NearPlace } from "./near-place";

const BELEM = {
  name: "Torre de Belém",
  label: "Torre de Belém, Lisboa",
  lat: 38.6916,
  lon: -9.2159,
};

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
      <form data-testid="form" onSubmit={(e) => e.preventDefault()}>
        {ui}
      </form>
    </NextIntlClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("Біля місця (етап 5)", () => {
  it("шукає лише кнопкою, вибір — приховані near/nearname у формі", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ status: "ok", places: [BELEM] })));
    const submit = vi.fn();
    wrap(<NearPlace city="LIS" near={null} name={undefined} autoApply />);
    screen.getByTestId("form").addEventListener("submit", submit);

    const input = screen.getByLabelText("Адреса чи визначне місце");
    fireEvent.change(input, { target: { value: "Belém" } });
    expect(fetchMock).not.toHaveBeenCalled(); // без автодоповнення (політика Nominatim)

    await act(async () => {
      fireEvent.click(screen.getByTestId("near-place-search"));
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/places/geocode?q=Bel%C3%A9m&city=LIS");

    await act(async () => {
      fireEvent.click(screen.getByTestId("near-place-option"));
      await new Promise((r) => setTimeout(r, 0));
    });
    const form = new FormData(screen.getByTestId("form") as HTMLFormElement);
    expect(form.get("near")).toBe("38.6916,-9.2159");
    expect(form.get("nearname")).toBe("Torre de Belém");
    expect(screen.getByTestId("near-place-chosen")).toHaveTextContent("Torre de Belém");
    expect(submit).toHaveBeenCalled();
  });

  it("помилка джерела — чесне повідомлення, а не зламаний фільтр", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "error", places: [] }), { status: 502 }),
    );
    wrap(<NearPlace city="LIS" near={null} name={undefined} autoApply={false} />);
    fireEvent.change(screen.getByLabelText("Адреса чи визначне місце"), {
      target: { value: "Rossio" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("near-place-search"));
    });
    expect(screen.getByRole("status")).toHaveTextContent("Пошук місць зараз недоступний");
  });

  it("URL: nearname лише з near; «ближче до місця» — за відстанню по прямій", () => {
    const state = parseStayParams({
      city: "LIS",
      in: "2026-12-05",
      out: "2026-12-08",
      near: "38.6916,-9.2159",
      nearname: "Torre de Belém",
      radius: "3",
      sort: "near",
    })!;
    expect(state.nearName).toBe("Torre de Belém");
    expect(toStayParams(state).get("nearname")).toBe("Torre de Belém");
    expect(
      parseStayParams({ city: "LIS", in: "2026-12-05", out: "2026-12-08", nearname: "X" })!
        .nearName,
    ).toBeUndefined();

    const stay = (id: string, lat: number | null, lon: number | null) =>
      ({ id, source: "mock", price_per_night: 100, latitude: lat, longitude: lon }) as Stay;
    const sorted = sortStays(
      [stay("far", 38.72, -9.14), stay("none", null, null), stay("near", 38.695, -9.21)],
      "near",
      new Map(),
      { lat: 38.6916, lon: -9.2159 },
    );
    expect(sorted.map((s) => s.id)).toEqual(["near", "far", "none"]);
    expect(distanceKm({ lat: 38.6916, lon: -9.2159 }, { lat: 38.72, lon: -9.14 })).toBeCloseTo(
      7.2,
      0,
    );
  });
});
