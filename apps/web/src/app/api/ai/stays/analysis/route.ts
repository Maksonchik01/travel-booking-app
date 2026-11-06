import type { NextRequest } from "next/server";

import { analyzeStays } from "@/lib/api";

const MAX_STAYS = 3;

/** Резюме відгуків для вибраних об'єктів: браузер ходить сюди, а не напряму в API. */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const { query, stay_keys } = (body ?? {}) as Record<string, unknown>;
  const keys = Array.isArray(stay_keys)
    ? stay_keys.filter((k): k is string => typeof k === "string").slice(0, MAX_STAYS)
    : [];
  if (typeof query !== "object" || query === null || keys.length === 0) {
    return Response.json({ error: "query and stay_keys are required" }, { status: 400 });
  }
  // Запит перевіряє API (StayQuery); тут лише форма.
  const result = await analyzeStays(query as Parameters<typeof analyzeStays>[0], keys);
  if (!result.ok) {
    return Response.json({ status: "unavailable" }, { status: 502 });
  }
  return Response.json(result.data);
}
