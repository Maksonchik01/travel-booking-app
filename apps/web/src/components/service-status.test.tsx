import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import messages from "../../messages/uk.json";
import { ServiceStatus } from "./service-status";
import type { ApiStatus } from "@/lib/api";

function renderStatus(status: ApiStatus) {
  return render(
    <NextIntlClientProvider locale="uk" messages={messages}>
      <ServiceStatus status={status} />
    </NextIntlClientProvider>,
  );
}

describe("ServiceStatus", () => {
  it("показує, що API недоступний", () => {
    renderStatus({ kind: "unreachable" });

    expect(screen.getByText("API недоступний")).toBeInTheDocument();
  });

  it("показує стан кожної залежності при частковій відмові", () => {
    renderStatus({
      kind: "degraded",
      data: {
        status: "degraded",
        checks: {
          database: { status: "ok", latency_ms: 3.2, error: null },
          redis: { status: "error", latency_ms: null, error: "timeout" },
        },
      },
    });

    expect(screen.getByText("Частково недоступно")).toBeInTheDocument();
    expect(screen.getByTestId("check-database")).toHaveTextContent("Працює · 3.2 мс");
    expect(screen.getByTestId("check-redis")).toHaveTextContent("Недоступно");
  });
});
