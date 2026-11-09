import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnalyticsListener } from "@/components/analytics-listener";

import { track } from "./analytics";

function beacons() {
  const sent: unknown[] = [];
  vi.stubGlobal("navigator", {
    ...navigator,
    doNotTrack: null,
    sendBeacon: (url: string, data: Blob) => {
      sent.push(url);
      void data.text().then((text) => sent.push(JSON.parse(text)));
      return true;
    },
  });
  return sent;
}

afterEach(() => vi.unstubAllGlobals());

describe("аналітика (модуль 19)", () => {
  it("надсилає подію з мітками у фоні", async () => {
    const sent = beacons();
    track("trip_saved", { source: "new" });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["/api/events", { name: "trip_saved", props: { source: "new" } }]);
  });

  it("поважає «не відстежувати» (GPC і DNT)", () => {
    const send = vi.fn(() => true);
    vi.stubGlobal("navigator", { ...navigator, globalPrivacyControl: true, sendBeacon: send });
    track("outbound");
    vi.stubGlobal("navigator", { ...navigator, doNotTrack: "1", sendBeacon: send });
    track("outbound");
    expect(send).not.toHaveBeenCalled();
  });

  it("делегований облік: кнопка з data-track і розкриття <details>", async () => {
    const sent = beacons();
    render(
      <div>
        <AnalyticsListener />
        <button type="button" data-track="compare_opened" data-track-kind="flight">
          go
        </button>
        <details data-track="offer_opened" data-track-kind="flight">
          <summary>more</summary>
        </details>
      </div>,
    );
    document.querySelector("button")!.click();
    const details = document.querySelector("details")!;
    details.open = true; // браузер (і happy-dom) сам шле подію toggle
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.filter((x) => typeof x === "object")).toEqual([
      { name: "compare_opened", props: { kind: "flight" } },
      { name: "offer_opened", props: { kind: "flight" } },
    ]);
  });
});
