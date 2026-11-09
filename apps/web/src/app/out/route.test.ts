import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const after = vi.fn();
const logOutboundClick = vi.fn();
const recordEvent = vi.fn();

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (cb: () => unknown) => after(cb),
}));
vi.mock("@/lib/api", () => ({
  logOutboundClick: (click: unknown) => logOutboundClick(click),
  recordEvent: (event: unknown) => recordEvent(event),
}));

const { GET } = await import("./route");

function get(params: Record<string, string>) {
  return GET(new NextRequest(`https://tickets.test/out?${new URLSearchParams(params)}`));
}

describe("GET /out", () => {
  beforeEach(() => {
    after.mockReset();
    logOutboundClick.mockReset();
    recordEvent.mockReset();
  });

  it("редиректить до партнера й рахує клік після відповіді", () => {
    const url = "https://www.aviasales.com/search/x?marker=1";
    const response = get({ url, kind: "flight", source: "travelpayouts" });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(url);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    // Після відповіді: облік переходу й анонімна подія (модуль 19).
    expect(after).toHaveBeenCalledTimes(2);
    for (const [cb] of after.mock.calls) cb();
    expect(logOutboundClick).toHaveBeenCalledWith({
      kind: "flight",
      source: "travelpayouts",
      host: "www.aviasales.com",
    });
    expect(recordEvent).toHaveBeenCalledWith({
      name: "outbound",
      props: { kind: "flight", source: "travelpayouts" },
    });
  });

  it("не редиректить на невідомий сайт", () => {
    const response = get({ url: "https://evil.example/", kind: "flight", source: "serpapi" });
    expect(response.status).toBe(400);
    expect(after).not.toHaveBeenCalled();
  });

  it("з дивним джерелом редиректить, але клік не пише", () => {
    const response = get({ url: "https://www.google.com/travel/flights?x=1", source: "<b>" });
    expect(response.status).toBe(302);
    expect(after).not.toHaveBeenCalled();
  });
});
