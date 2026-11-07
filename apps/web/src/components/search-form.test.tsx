import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import messages from "../../messages/uk.json";
import { SearchForm } from "./search-form";

vi.mock("next/form", () => ({
  default: (props: React.FormHTMLAttributes<HTMLFormElement>) => <form {...props} />,
}));

function hiddenFilters(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLInputElement>("input[type=hidden]")]
    .filter((i) => ["stops", "dep"].includes(i.name))
    .map((i) => `${i.name}=${i.value}`);
}

describe("SearchForm: збережені фільтри", () => {
  it("додаються до нового пошуку, поки позначку не знято", () => {
    const { container } = render(
      <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
        <SearchForm initial={null} savedFilters="stops=0&dep=morning" />
      </NextIntlClientProvider>,
    );

    const toggle = screen.getByRole("checkbox", { name: "Застосувати збережені фільтри (2)" });
    expect(toggle).toBeChecked();
    expect(hiddenFilters(container)).toEqual(["stops=0", "dep=morning"]);

    fireEvent.click(toggle);
    expect(hiddenFilters(container)).toEqual([]);
  });

  it("без збережених — без позначки", () => {
    render(
      <NextIntlClientProvider locale="uk" messages={messages} timeZone="UTC">
        <SearchForm initial={null} />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByRole("checkbox", { name: /збережені фільтри/ })).toBeNull();
  });
});
