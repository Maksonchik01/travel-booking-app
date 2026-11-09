import { API_URL, sessionToken } from "@/lib/session";

const TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * Власне фото профілю: лише власнику (сесія з httpOnly-cookie). Адреса містить `?v=` —
 * версію фото, тож браузер може кешувати її довго, а нове фото — нова адреса.
 */
export async function GET() {
  const token = await sessionToken();
  if (!token) return new Response(null, { status: 401 });
  const response = await fetch(`${API_URL}/account/avatar`, {
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => null);
  const type = response?.headers.get("content-type") ?? "";
  if (!response?.ok || !TYPES.has(type)) return new Response(null, { status: 404 });
  return new Response(await response.arrayBuffer(), {
    headers: {
      "content-type": type,
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}
