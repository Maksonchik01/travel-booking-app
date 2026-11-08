import type { TripRefreshRequest } from "@tickets/shared";
import type { NextRequest } from "next/server";

import { fetchTripRefresh } from "@/lib/api";

/** «Оновити ціни» збереженої поїздки: браузер ходить сюди, а не напряму в API. */
export async function POST(request: NextRequest) {
  let body: TripRefreshRequest;
  try {
    body = (await request.json()) as TripRefreshRequest;
  } catch {
    return Response.json({ status: "error" }, { status: 400 });
  }
  const result = await fetchTripRefresh(body);
  if (!result.ok) {
    return Response.json(
      { status: result.reason === "rate_limited" ? "rate_limited" : "error" },
      { status: result.reason === "rate_limited" ? 429 : 502 },
    );
  }
  return Response.json(result.data);
}
