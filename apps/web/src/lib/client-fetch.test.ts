import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWithTimeout } from "./client-fetch";

afterEach(() => vi.unstubAllGlobals());

describe("повільне з'єднання (модуль 21.6)", () => {
  it("запит, що не відповів вчасно, обривається помилкою — а не висить", async () => {
    vi.stubGlobal(
      "fetch",
      (_: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    await expect(fetchWithTimeout("/api/slow", {}, 20)).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("власний сигнал (скасування) має перевагу над тайм-аутом", async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal("fetch", async (_: string, init?: RequestInit) => {
      seen.push(init?.signal);
      return new Response("ok");
    });
    const controller = new AbortController();
    await fetchWithTimeout("/api/x", { signal: controller.signal });
    expect(seen[0]).toBe(controller.signal);
  });
});
