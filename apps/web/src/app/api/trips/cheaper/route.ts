import type { TripQuery } from "@tickets/shared";
import type { NextRequest } from "next/server";

import { fetchCheaperTrip } from "@/lib/api";

/** «Знайти дешевший варіант» з «Вашої поїздки»: браузер ходить сюди, а не напряму в API. */
export async function POST(request: NextRequest) {
  let body: TripQuery;
  try {
    body = (await request.json()) as TripQuery;
  } catch {
    return Response.json({ status: "error" }, { status: 400 });
  }
  const result = await fetchCheaperTrip(body);
  if (!result.ok) {
    const status = result.reason === "rate_limited" ? "rate_limited" : "error";
    return Response.json({ status }, { status: result.reason === "rate_limited" ? 429 : 502 });
  }
  return Response.json(result.data);
}
