import type { NextRequest } from "next/server";

import { defaultLocale, isLocale, LOCALE_COOKIE } from "@/i18n/config";
import { fetchGeocode } from "@/lib/api";

const MAX_QUERY_LENGTH = 120;
const IATA = /^[A-Za-z]{3}$/;

/**
 * Місце біля житла (етап 5, ADR 0049): браузер — сюди, сервер — до API, API — до OpenStreetMap
 * Nominatim. Лише за кнопкою «Знайти» (політика Nominatim забороняє автодоповнення).
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const q = params.get("q")?.trim().slice(0, MAX_QUERY_LENGTH) ?? "";
  const city = params.get("city") ?? "";
  if (q.length < 2 || !IATA.test(city)) return Response.json({ status: "ok", places: [] });
  const cookie = request.cookies.get(LOCALE_COOKIE)?.value;
  const lang = (isLocale(cookie) ? cookie : defaultLocale) === "en" ? "en" : "uk";
  const result = await fetchGeocode(q, city.toUpperCase(), lang);
  if (!result.ok) {
    return Response.json(
      { status: "error", places: [] },
      { status: result.reason === "rate_limited" ? 429 : 502 },
    );
  }
  return Response.json(result.data, { headers: { "Cache-Control": "private, max-age=3600" } });
}
