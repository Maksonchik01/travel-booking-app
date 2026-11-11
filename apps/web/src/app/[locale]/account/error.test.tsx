import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/uk.json";

import AccountError from "./error";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

describe("кабінет недоступний (V3, етап 7)", () => {
  it("пояснює збій, не відправляє на вхід і дає повторити", () => {
    const reset = vi.fn();
    render(
      <NextIntlClientProvider locale="uk" messages={messages}>
        <AccountError error={new Error("account_unavailable")} reset={reset} />
      </NextIntlClientProvider>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Ви не вийшли з акаунта");
    fireEvent.click(screen.getByTestId("account-retry"));
    expect(refresh).toHaveBeenCalled();
    expect(reset).toHaveBeenCalled();
  });
});
