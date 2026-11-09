import { describe, expect, it } from "vitest";

import { deviceLabel } from "@/lib/device";

describe("deviceLabel", () => {
  it("names browser and OS only", () => {
    expect(
      deviceLabel(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
      ),
    ).toBe("Chrome · macOS");
    expect(
      deviceLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari · iOS");
    expect(
      deviceLabel(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0",
      ),
    ).toBe("Edge · Windows");
    expect(deviceLabel("curl/8.0")).toBeNull();
    expect(deviceLabel(null)).toBeNull();
  });
});
