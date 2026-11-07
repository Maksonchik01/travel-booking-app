"use server";

import type { Account, SearchEntry, SessionOut } from "@tickets/shared";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { call, clearSession, sessionToken, setSession } from "@/lib/session";

/** Стан форми для useActionState: код помилки з API перекладає UI (messages → authErrors). */
export type FormState = { status: "idle" | "ok" | "error"; code?: string };

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const raw = (form: FormData, key: string) => String(form.get(key) ?? "");

/** Куди повернутися після входу: лише відносний шлях на нашому сайті. */
function safeNext(form: FormData): string {
  const next = raw(form, "next");
  return next.startsWith("/") && !next.startsWith("//") ? next : "/account";
}

function fail(code: string): FormState {
  return { status: "error", code };
}

export async function login(_: FormState, form: FormData): Promise<FormState> {
  const result = await call<SessionOut>(
    "POST",
    "/auth/login",
    { login: text(form, "login"), password: raw(form, "password") },
    null,
  );
  if (!result.ok) return fail(result.status === 422 ? "invalid_credentials" : result.code);
  await setSession(result.data);
  redirect(safeNext(form));
}

export async function register(_: FormState, form: FormData): Promise<FormState> {
  if (raw(form, "password") !== raw(form, "password2")) return fail("passwords_differ");
  const result = await call<SessionOut>(
    "POST",
    "/auth/register",
    {
      username: text(form, "username"),
      password: raw(form, "password"),
      first_name: text(form, "first_name") || null,
      last_name: text(form, "last_name") || null,
    },
    null,
  );
  if (!result.ok) return fail(result.status === 422 ? "invalid_registration" : result.code);
  await setSession(result.data);
  redirect(safeNext(form));
}

export async function logout(form: FormData): Promise<void> {
  const token = await sessionToken();
  if (token) {
    const everywhere = form.get("everywhere") === "1";
    await call("POST", `/auth/logout${everywhere ? "?everywhere=true" : ""}`, undefined, token);
  }
  await clearSession();
  redirect("/");
}

export async function forgotPassword(_: FormState, form: FormData): Promise<FormState> {
  const result = await call("POST", "/auth/password/forgot", { email: text(form, "email") }, null);
  // Відповідь однакова незалежно від того, чи є така адреса.
  return result.ok || result.status !== 422 ? { status: "ok" } : fail("invalid_email");
}

export async function resetPassword(_: FormState, form: FormData): Promise<FormState> {
  if (raw(form, "password") !== raw(form, "password2")) return fail("passwords_differ");
  const result = await call<SessionOut>(
    "POST",
    "/auth/password/reset",
    { token: text(form, "token"), new_password: raw(form, "password") },
    null,
  );
  if (!result.ok) return fail(result.status === 422 ? "weak_password" : result.code);
  await setSession(result.data);
  redirect("/account?done=password");
}

export async function verifyEmail(_: FormState, form: FormData): Promise<FormState> {
  const result = await call("POST", "/auth/email/verify", { token: text(form, "token") }, null);
  if (!result.ok) return fail(result.code);
  revalidatePath("/account");
  return { status: "ok" };
}

// --- кабінет (потрібна сесія) -----------------------------------------------------------

async function authed<T>(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<FormState & { data?: T }> {
  const token = await sessionToken();
  if (!token) redirect("/login?next=/account");
  const result = await call<T>(method, path, body, token);
  if (!result.ok) {
    if (result.status === 401) redirect("/login?next=/account");
    return fail(result.status === 422 ? "invalid_input" : result.code);
  }
  revalidatePath("/account");
  return { status: "ok", data: result.data };
}

export async function updateProfile(_: FormState, form: FormData): Promise<FormState> {
  const { status, code } = await authed<Account>("PATCH", "/account/profile", {
    first_name: text(form, "first_name") || null,
    last_name: text(form, "last_name") || null,
  });
  return { status, code };
}

export async function changeEmail(_: FormState, form: FormData): Promise<FormState> {
  const { status, code } = await authed("POST", "/account/email", { email: text(form, "email") });
  return { status, code };
}

export async function changePassword(_: FormState, form: FormData): Promise<FormState> {
  if (raw(form, "password") !== raw(form, "password2")) return fail("passwords_differ");
  const current = raw(form, "current");
  const { status, code } = await authed("POST", "/account/password", {
    current_password: current || null,
    new_password: raw(form, "password"),
  });
  return { status, code };
}

export async function unlinkGoogle(): Promise<FormState> {
  const { status, code } = await authed("DELETE", "/account/google");
  return { status, code };
}

/** Одноразове посилання t.me/<бот>?start=link_… (30 хв): бот прив'яже свій чат до акаунта. */
export async function linkTelegram(): Promise<FormState> {
  const result = await authed<{ url: string }>("POST", "/account/telegram/link");
  if (result.status !== "ok" || !result.data?.url.startsWith("https://t.me/")) {
    return { status: "error", code: result.code };
  }
  redirect(result.data.url);
}

export async function unlinkTelegram(): Promise<FormState> {
  const { status, code } = await authed("DELETE", "/account/telegram");
  return { status, code };
}

export async function deleteAccount(_: FormState, form: FormData): Promise<FormState> {
  const result = await authed("POST", "/account/delete", { confirm: raw(form, "confirm") });
  if (result.status !== "ok") return { status: result.status, code: result.code };
  await clearSession();
  redirect("/?done=deleted");
}

export async function clearHistory(): Promise<void> {
  await authed("DELETE", "/account/history");
}

export async function deleteSearch(form: FormData): Promise<void> {
  await authed("DELETE", `/account/searches/${encodeURIComponent(text(form, "id"))}`);
}

export async function renameSearch(_: FormState, form: FormData): Promise<FormState> {
  const { status, code } = await authed<SearchEntry>(
    "PATCH",
    `/account/searches/${encodeURIComponent(text(form, "id"))}`,
    { title: text(form, "title") },
  );
  return { status, code };
}

/** «Зберегти пошук» з результатів. Гість — на вхід з поверненням на ці результати. */
export async function saveSearch(_: FormState, form: FormData): Promise<FormState> {
  const back = raw(form, "back");
  if (!(await sessionToken())) redirect(`/login?next=${encodeURIComponent(back)}`);
  const { status, code } = await authed<SearchEntry>("POST", "/account/saved", {
    kind: text(form, "kind"),
    params: raw(form, "params"),
    title: text(form, "title"),
  });
  return { status, code };
}
