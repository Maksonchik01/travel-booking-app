// Лише для сервера: next/headers недоступний у клієнтському коді.
import type { SessionOut } from "@tickets/shared";
import { cookies } from "next/headers";

const API_URL = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const TIMEOUT_MS = 15_000;
/** Токен сесії — лише в httpOnly-cookie: JavaScript сторінки його не бачить. */
export const SESSION_COOKIE = "tickets_session";
export const OAUTH_STATE_COOKIE = "tickets_oauth_state";

export type CallResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string };

/** Виклик API від імені користувача (токен з cookie → Authorization: Bearer). */
export async function call<T = null>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  token?: string | null,
): Promise<CallResult<T>> {
  const auth = token === undefined ? await sessionToken() : token;
  try {
    const response = await fetch(`${API_URL}${path}`, {
      method,
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      const code =
        detail && typeof detail.detail === "string" ? detail.detail : `http_${response.status}`;
      return { ok: false, status: response.status, code };
    }
    const text = await response.text();
    return { ok: true, data: (text ? JSON.parse(text) : null) as T };
  } catch {
    return { ok: false, status: 0, code: "unreachable" };
  }
}

export async function sessionToken(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
}

/** Лише в Server Functions і Route Handlers (там можна змінювати cookie). */
export async function setSession(session: SessionOut): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(session.expires_at),
  });
}

/** Той самий cookie заголовком — для Route Handlers, що повертають власний Response. */
export function sessionCookieHeader(session: SessionOut): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const expires = new Date(session.expires_at).toUTCString();
  return `${SESSION_COOKIE}=${session.token}; Path=/; Expires=${expires}; HttpOnly; SameSite=Lax${secure}`;
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

export type Me = { username: string; first_name: string };

/** Хто увійшов (для шапки й сторінок); null — гість або сесія закінчилась. */
export async function currentUser(): Promise<Me | null> {
  const token = await sessionToken();
  if (!token) return null;
  const result = await call<Me>("GET", "/auth/me", undefined, token);
  return result.ok ? result.data : null;
}

/**
 * Запис пошуку в історію кабінету — після відповіді (next/server `after`), щоб не
 * сповільнювати сторінку. Токен читаємо ДО after: у Server Components cookies() у
 * колбеку after недоступні.
 */
export function recordHistory(
  token: string | null,
  entry: { kind: "flights" | "stays" | "trip"; params: string; title: string },
): () => Promise<void> {
  return async () => {
    if (!token) return;
    await call("POST", "/account/history", entry, token);
  };
}
