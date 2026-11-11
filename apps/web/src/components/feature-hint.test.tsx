import { act, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it } from "vitest";

import messages from "../../messages/uk.json";
import { cameBack, readListPosition, saveListPosition } from "@/lib/list-position";

import { FeatureHint } from "./feature-hint";

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("підказки й позиція списку (етап 9)", () => {
  it("підказка — один раз: закрита не повертається", async () => {
    const first = await act(async () => wrap(<FeatureHint id="explore" />));
    expect(screen.getByTestId("hint-explore")).toHaveTextContent("категорії вмикаються");
    fireEvent.click(screen.getByRole("button", { name: "Зрозуміло, сховати" }));
    expect(screen.queryByTestId("hint-explore")).toBeNull();
    first.unmount();

    await act(async () => {
      wrap(<FeatureHint id="explore" />);
    });
    expect(screen.queryByTestId("hint-explore")).toBeNull();
  });

  it("позиція списку: зберігається за адресою; «Назад» — лише після popstate", () => {
    saveListPosition("/stays?city=LIS", { limit: 20, y: 1400 });
    expect(readListPosition("/stays?city=LIS")).toEqual({ limit: 20, y: 1400 });
    expect(readListPosition("/stays?city=BCN")).toBeNull();
    expect(cameBack()).toBe(false);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(cameBack()).toBe(true);
    expect(cameBack(Date.now() + 10_000)).toBe(false);
  });
});
