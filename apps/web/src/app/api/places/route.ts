import type { NextRequest } from "next/server";

import { fetchPlaces } from "@/lib/api";

const MAX_QUERY_LENGTH = 64;

/** Підказки міст і аеропортів для форми: браузер ходить сюди, а не напряму в API. */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim().slice(0, MAX_QUERY_LENGTH) ?? "";
  if (q.length < 2) return Response.json([]);

  const result = await fetchPlaces(q);
  if (!result.ok) return Response.json([], { status: 502 });
  // Довідник змінюється лише з оновленням знімка — браузер може тримати відповідь добу.
  return Response.json(result.data, { headers: { "Cache-Control": "public, max-age=86400" } });
}
