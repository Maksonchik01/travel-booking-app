"use server";

import type { Account, SearchPrefs } from "@tickets/shared";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import type { FormState } from "@/app/actions/account";
import { isLocale, LOCALE_COOKIE } from "@/i18n/config";
import { API_URL, call, sessionToken } from "@/lib/session";
import { searchPrefsFromForm } from "@/lib/search-prefs";

/** Мірило API (300 КБ): більше — одразу помилка, без відправки. */
const MAX_AVATAR_BYTES = 300 * 1024;
const YEAR = 365 * 24 * 3600;

async function token(): Promise<string> {
  const value = await sessionToken();
  if (!value) redirect("/login?next=/account/settings");
  return value;
}

function done(result: { ok: boolean; status?: number; code?: string }): FormState {
  if (result.ok) {
    revalidatePath("/", "layout");
    return { status: "ok" };
  }
  if (result.status === 401) redirect("/login?next=/account/settings");
  return { status: "error", code: result.code === "http_422" ? "invalid_input" : result.code };
}

/** Мова, валюта, країна, домашній і улюблені аеропорти. Нова мова — одразу й у cookie. */
export async function savePreferences(_: FormState, form: FormData): Promise<FormState> {
  const value = (key: string) => String(form.get(key) ?? "").trim() || null;
  const locale = value("locale");
  const result = await call<Account>(
    "PUT",
    "/account/preferences",
    {
      locale,
      currency: value("currency"),
      country: value("country"),
      home_airport: value("home_airport"),
      favorite_airports: form
        .getAll("favorite_airports")
        .map((v) => String(v).trim())
        .filter(Boolean),
    },
    await token(),
  );
  const state = done(result);
  if (state.status === "ok" && isLocale(locale)) {
    (await cookies()).set(LOCALE_COOKIE, locale, { path: "/", maxAge: YEAR, sameSite: "lax" });
  }
  return state;
}

/** Перемикач мови в шапці: з акаунтом — запам'ятати й у профілі (інші пристрої). */
export async function saveLocale(locale: string): Promise<void> {
  if (!isLocale(locale)) return;
  (await cookies()).set(LOCALE_COOKIE, locale, { path: "/", maxAge: YEAR, sameSite: "lax" });
  const session = await sessionToken();
  if (session) await call("PUT", "/account/locale", { locale }, session);
}

export async function saveSearchPrefs(_: FormState, form: FormData): Promise<FormState> {
  const prefs: SearchPrefs = searchPrefsFromForm(form);
  return done(await call<Account>("PUT", "/account/search-preferences", prefs, await token()));
}

export async function resetSearchPrefs(): Promise<FormState> {
  return done(await call<Account>("PUT", "/account/search-preferences", {}, await token()));
}

/** Тіло для API — самі байти зображення; тип API визначає за вмістом, а не за назвою. */
export async function uploadAvatar(_: FormState, form: FormData): Promise<FormState> {
  const file = form.get("avatar");
  if (!(file instanceof File) || file.size === 0) return { status: "error", code: "invalid_image" };
  if (file.size > MAX_AVATAR_BYTES) return { status: "error", code: "image_too_large" };
  const auth = await token();
  const response = await fetch(`${API_URL}/account/avatar`, {
    method: "PUT",
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/octet-stream" },
    body: await file.arrayBuffer(),
  }).catch(() => null);
  if (!response) return { status: "error", code: "unreachable" };
  const detail = response.ok ? null : await response.json().catch(() => null);
  return done({
    ok: response.ok,
    status: response.status,
    code: typeof detail?.detail === "string" ? detail.detail : `http_${response.status}`,
  });
}

export async function removeAvatar(): Promise<FormState> {
  return done(await call<Account>("DELETE", "/account/avatar", undefined, await token()));
}
