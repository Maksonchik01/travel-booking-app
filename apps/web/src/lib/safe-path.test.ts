import { describe, expect, it } from "vitest";

import { safeLocalPath } from "./safe-path";

describe("safeLocalPath (V3, етап 4)", () => {
  it("лишає шляхи цього сайту", () => {
    expect(safeLocalPath("/account", "/x")).toBe("/account");
    expect(safeLocalPath("/trip?from=WAW&to=LIS#your-trip", "/x")).toBe(
      "/trip?from=WAW&to=LIS#your-trip",
    );
  });

  it("відкидає перенаправлення на інший сайт", () => {
    for (const bad of [
      "//evil.example",
      "/\\evil.example",
      "/\\/evil.example",
      "https://evil.example",
      "javascript:alert(1)",
      "/\tevil",
      "account",
      "",
      undefined,
      ["/account"],
    ]) {
      expect(safeLocalPath(bad, "/account")).toBe("/account");
    }
  });
});
