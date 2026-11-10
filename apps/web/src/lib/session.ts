// Лише для сервера: next/headers недоступний у клієнтському коді.
import type { Account, Me, SearchKind, SessionOut } from "@tickets/shared";
import { cookies, headers } from "next/headers";
import { cache } from "react";

import { isLocale, LOCALE_COOKIE } from "@/i18n/config";
import { clientIpHeaders } from "@/lib/client-ip";
import { deviceLabel } from "@/lib/device";

export const API_URL =
  process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const TIMEOUT_MS = 15_000;
/** Токен сесії — лише в httpOnly-cookie: JavaScript сторінки його не бачить. */
export const SESSION_COOKIE = "tickets_session";
export const OAUTH_STATE_COOKIE = "tickets_oauth_state";

export type CallResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string };

/** Виклик API від імені користувача (токен з cookie → Authorization: Bearer). */
export async function call<T = null>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
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
        ...(await clientIpHeaders()),
        ...(await deviceHeader()),
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

/** Браузер і ОС відвідувача — API пише їх у нову сесію (список сесій у «Безпеці»). */
async function deviceHeader(): Promise<Record<string, string>> {
  try {
    const label = deviceLabel((await headers()).get("user-agent"));
    return label ? { "x-client-device": label } : {};
  } catch {
    return {}; // поза запитом (напр. after) — без пристрою
  }
}

export async function sessionToken(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
}

/** Лише в Server Functions і Route Handlers (там можна змінювати cookie). */
export async function setSession(session: SessionOut): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(session.expires_at),
  });
  const locale = await profileLocale(session.token);
  if (locale)
    jar.set(LOCALE_COOKIE, locale, { path: "/", maxAge: LOCALE_MAX_AGE, sameSite: "lax" });
}

const LOCALE_MAX_AGE = 365 * 24 * 3600;

/** Мова з профілю (вибрана на іншому пристрої) — після входу сайт відкривається нею. */
export async function profileLocale(token: string): Promise<string | null> {
  const me = await call<Me>("GET", "/auth/me", undefined, token);
  return me.ok && isLocale(me.data.locale) ? me.data.locale : null;
}

/** Cookie мови заголовком — для Route Handlers з власним Response (вхід через Google). */
export function localeCookieHeader(locale: string): string {
  return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${LOCALE_MAX_AGE}; SameSite=Lax`;
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

/** Хто увійшов (для шапки й сторінок); null — гість або сесія закінчилась. */
export async function currentUser(): Promise<Me | null> {
  const token = await sessionToken();
  if (!token) return null;
  const result = await call<Me>("GET", "/auth/me", undefined, token);
  return result.ok ? result.data : null;
}

/** Профіль для значень за замовчуванням нового пошуку; гість чи помилка — null. */
/** Один запит на рендер: форма й видача на тій самій сторінці беруть той самий акаунт. */
export const currentAccount = cache(async (): Promise<Account | null> => {
  const token = await sessionToken();
  if (!token) return null;
  const result = await call<Account>("GET", "/account", undefined, token);
  return result.ok ? result.data : null;
});

/**
 * Запис пошуку в історію кабінету — після відповіді (next/server `after`), щоб не
 * сповільнювати сторінку. Токен читаємо ДО after: у Server Components cookies() у
 * колбеку after недоступні.
 */
export function recordHistory(
  token: string | null,
  entry: { kind: SearchKind; params: string; title: string },
): () => Promise<void> {
  return async () => {
    if (!token) return;
    await call("POST", "/account/history", entry, token);
  };
}
