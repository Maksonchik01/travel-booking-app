import type { SellersRequest } from "@tickets/shared";
import type { NextRequest } from "next/server";

import { fetchSellers } from "@/lib/api";

/** «Порівняти продавців» з картки: браузер ходить сюди, а не напряму в API. */
export async function POST(request: NextRequest) {
  let body: SellersRequest;
  try {
    body = (await request.json()) as SellersRequest;
  } catch {
    return Response.json({ status: "error", sellers: [] }, { status: 400 });
  }
  const result = await fetchSellers(body);
  if (!result.ok) {
    const status = result.reason === "rate_limited" ? "rate_limited" : "error";
    return Response.json(
      { status, sellers: [] },
      { status: result.reason === "rate_limited" ? 429 : 502 },
    );
  }
  return Response.json(result.data);
}
