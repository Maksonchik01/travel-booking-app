import type { ExplainResult } from "@tickets/shared";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import messages from "../../messages/uk.json";
import { AIExplanation } from "./ai-explanation";

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("AIExplanation", () => {
  it("показує рекомендацію людською назвою варіанта і ризики", () => {
    const result: ExplainResult = {
      status: "ok",
      explanation: {
        summary: "Найдешевший — 53 EUR, але виліт о 05:30.",
        recommended_id: "balanced",
        recommendation_reason: "Без нічного вильоту.",
        options: [
          { id: "cheapest", pros: ["53 EUR"], cons: [], risks: ["Нічний виліт"], one_liner: "" },
        ],
        price_assessment: { available: false, text: "Історії цін поки замало." },
        timing_advice: { available: false, text: "" },
        data_freshness_note: "",
        flags: [],
      },
    };

    wrap(<AIExplanation result={result} />);

    expect(screen.getByText("Радимо: Збалансований.")).toBeInTheDocument();
    expect(screen.getByText("Найдешевший")).toBeInTheDocument();
    expect(screen.getByText("Нічний виліт")).toBeInTheDocument();
  });

  it("нема пояснення — нема блоку", () => {
    const { container } = wrap(<AIExplanation result={{ status: "rejected" }} />);

    expect(container).toBeEmptyDOMElement();
  });
});
