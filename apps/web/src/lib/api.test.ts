import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchReadiness } from "./api";

const readyBody = {
  status: "ok",
  checks: {
    database: { status: "ok", latency_ms: 1, error: null },
    redis: { status: "ok", latency_ms: 1, error: null },
  },
};

function mockFetch(impl: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchReadiness", () => {
  it("повертає ok для 200", async () => {
    mockFetch(async () => Response.json(readyBody));

    expect(await fetchReadiness()).toEqual({ kind: "ok", data: readyBody });
  });

  it("повертає degraded з деталями для 503", async () => {
    const body = { ...readyBody, status: "degraded" };
    mockFetch(async () => Response.json(body, { status: 503 }));

    expect(await fetchReadiness()).toEqual({ kind: "degraded", data: body });
  });

  it("не падає, якщо API недоступний", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });

    expect(await fetchReadiness()).toEqual({ kind: "unreachable" });
  });

  it("вважає неочікуваний статус недоступністю", async () => {
    mockFetch(async () => new Response("oops", { status: 500 }));

    expect(await fetchReadiness()).toEqual({ kind: "unreachable" });
  });
});
