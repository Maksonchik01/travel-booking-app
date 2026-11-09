import type { SessionOut } from "@tickets/shared";
import type { NextRequest } from "next/server";

import {
  call,
  localeCookieHeader,
  OAUTH_STATE_COOKIE,
  profileLocale,
  sessionCookieHeader,
} from "@/lib/session";

/** Повернення з Google: перевіряємо state з cookie, міняємо код на сесію (або прив'язку). */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const expected = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
  const fail = (reason: string) => redirect(request, `/login?error=${reason}`);

  if (params.get("error")) return fail("google_cancelled");
  if (!code || !state || !expected || state !== expected) return fail("google_failed");

  const result = await call<SessionOut | null>(
    "POST",
    "/auth/google/callback",
    { code, state },
    null,
  );
  if (!result.ok) {
    return result.code === "google_taken"
      ? redirect(request, "/account?error=google_taken")
      : fail(result.code);
  }
  if (result.data) {
    const locale = await profileLocale(result.data.token);
    return redirect(
      request,
      "/account?done=google_login",
      sessionCookieHeader(result.data),
      locale ? localeCookieHeader(locale) : undefined,
    );
  }
  return redirect(request, "/account?done=google_linked");
}

function redirect(
  request: NextRequest,
  path: string,
  sessionCookie?: string,
  localeCookie?: string,
): Response {
  const headers = new Headers({ location: new URL(path, request.url).toString() });
  // state одноразовий — прибираємо cookie.
  headers.append("set-cookie", `${OAUTH_STATE_COOKIE}=; Path=/api/auth/google; Max-Age=0`);
  if (sessionCookie) headers.append("set-cookie", sessionCookie);
  if (localeCookie) headers.append("set-cookie", localeCookie);
  return new Response(null, { status: 303, headers });
}
