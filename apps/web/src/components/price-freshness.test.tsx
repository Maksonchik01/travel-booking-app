import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import messages from "../../messages/uk.json";
import { FreshnessBadge } from "./price-freshness";

function badge(value?: Parameters<typeof FreshnessBadge>[0]["value"]) {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages}>
      <FreshnessBadge value={value} />
    </NextIntlClientProvider>,
  );
}

describe("FreshnessBadge", () => {
  it.each([
    ["live", "Ціна перевірена щойно"],
    ["cached", "Кешована ціна"],
    ["approximate", "Орієнтовна ціна"],
    ["needs_recheck", "Варто перевірити ціну"],
  ] as const)("%s → «%s» з поясненням", (value, text) => {
    badge(value);
    const el = screen.getByTestId("price-freshness");
    expect(el).toHaveTextContent(text);
    expect(el).toHaveAttribute("data-freshness", value);
    expect(el.getAttribute("title")).toBeTruthy();
  });

  it("без даних — нічого", () => {
    const { container } = badge(undefined);
    expect(container).toBeEmptyDOMElement();
  });
});
