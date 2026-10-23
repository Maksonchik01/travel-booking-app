import type { ReadinessResponse } from "@tickets/shared";

const API_URL = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export type ApiStatus =
  { kind: "ok" | "degraded"; data: ReadinessResponse } | { kind: "unreachable" };

export async function fetchReadiness(signal?: AbortSignal): Promise<ApiStatus> {
  try {
    const response = await fetch(`${API_URL}/health/ready`, { cache: "no-store", signal });
    // 503 теж повертає типізоване тіло з деталями перевірок.
    if (response.status !== 200 && response.status !== 503) {
      return { kind: "unreachable" };
    }
    const data = (await response.json()) as ReadinessResponse;
    return { kind: data.status, data };
  } catch {
    return { kind: "unreachable" };
  }
}
