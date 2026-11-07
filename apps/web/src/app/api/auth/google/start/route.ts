import type { NextRequest } from "next/server";

import { call, OAUTH_STATE_COOKIE, sessionToken } from "@/lib/session";

/**
 * Початок входу через Google: API видає адресу Google зі state і PKCE; state кладемо в
 * httpOnly-cookie, щоб на поверненні переконатися, що відповідь — для цього ж браузера.
 */
export async function GET(request: NextRequest) {
  const mode = request.nextUrl.searchParams.get("mode") === "link" ? "link" : "login";
  const token = mode === "link" ? await sessionToken() : null;
  const result = await call<{ url: string; state: string }>(
    "POST",
    "/auth/google/start",
    { mode },
    token,
  );
  if (!result.ok) {
    const back = mode === "link" ? "/account?error=" : "/login?error=";
    return Response.redirect(new URL(back + result.code, request.url), 303);
  }
  const headers = new Headers({ location: result.data.url });
  headers.append(
    "set-cookie",
    `${OAUTH_STATE_COOKIE}=${result.data.state}; Path=/api/auth/google; Max-Age=600; HttpOnly; SameSite=Lax${
      process.env.NODE_ENV === "production" ? "; Secure" : ""
    }`,
  );
  return new Response(null, { status: 303, headers });
}
