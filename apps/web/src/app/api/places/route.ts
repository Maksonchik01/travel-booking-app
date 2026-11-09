import type { NextRequest } from "next/server";

import { defaultLocale, isLocale, LOCALE_COOKIE } from "@/i18n/config";
import { fetchPlaces } from "@/lib/api";

const MAX_QUERY_LENGTH = 64;

/** Підказки міст і аеропортів для форми: браузер ходить сюди, а не напряму в API. */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim().slice(0, MAX_QUERY_LENGTH) ?? "";
  if (q.length < 2) return Response.json([]);

  const kind = request.nextUrl.searchParams.get("kind") === "city" ? "city" : "any";
  // Назви в довіднику — українською й англійською; для російської кирилиця ближча.
  const cookie = request.cookies.get(LOCALE_COOKIE)?.value;
  const lang = (isLocale(cookie) ? cookie : defaultLocale) === "en" ? "en" : "uk";
  const result = await fetchPlaces(q, 8, kind, lang);
  if (!result.ok) return Response.json([], { status: 502 });
  // Довідник змінюється лише з оновленням знімка — браузер може тримати відповідь добу
  // (мова — з cookie, тож лише приватний кеш).
  return Response.json(result.data, { headers: { "Cache-Control": "private, max-age=86400" } });
}
