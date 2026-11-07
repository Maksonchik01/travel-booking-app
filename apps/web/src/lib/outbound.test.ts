import { describe, expect, it } from "vitest";

import { isAllowedOutbound, outboundHref } from "./outbound";

describe("isAllowedOutbound", () => {
  it.each([
    "https://www.aviasales.com/search/WAW1012LIS1?marker=123",
    "https://www.google.com/travel/flights?tfs=abc",
  ])("пускає до відомих партнерів: %s", (url) => {
    expect(isAllowedOutbound(url)).toBe(true);
  });

  it.each([
    "https://evil.example/",
    "https://www.aviasales.com.evil.example/",
    "https://www.aviasales.com@evil.example/",
    "https://user:pw@www.aviasales.com/search",
    "http://www.aviasales.com/search",
    "https://www.google.com/search?q=x",
    "//www.aviasales.com/search",
    "javascript:alert(1)",
    "",
  ])("не пускає: %s", (url) => {
    expect(isAllowedOutbound(url)).toBe(false);
  });
});

describe("outboundHref", () => {
  it("кодує посилання в параметр", () => {
    expect(outboundHref("https://www.aviasales.com/s?a=1&b=2", "flight", "travelpayouts")).toBe(
      "/out?url=https%3A%2F%2Fwww.aviasales.com%2Fs%3Fa%3D1%26b%3D2&kind=flight&source=travelpayouts",
    );
  });
});
