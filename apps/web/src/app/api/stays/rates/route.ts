import type { StayRatesRequest } from "@tickets/shared";
import type { NextRequest } from "next/server";

import { fetchStayRates } from "@/lib/api";

/** «Порівняти ціни» з картки житла: браузер ходить сюди, а не напряму в API. */
export async function POST(request: NextRequest) {
  let body: StayRatesRequest;
  try {
    body = (await request.json()) as StayRatesRequest;
  } catch {
    return Response.json({ status: "error", rooms: [], sellers: 0 }, { status: 400 });
  }
  const result = await fetchStayRates(body);
  if (!result.ok) {
    const status = result.reason === "rate_limited" ? "rate_limited" : "error";
    return Response.json(
      { status, rooms: [], sellers: 0 },
      { status: result.reason === "rate_limited" ? 429 : 502 },
    );
  }
  return Response.json(result.data);
}
