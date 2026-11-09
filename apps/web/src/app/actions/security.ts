"use server";

import type { Account, NotifyPrefs } from "@tickets/shared";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import type { FormState } from "@/app/actions/account";
import { call, clearSession, sessionToken } from "@/lib/session";

const INTERVALS = [24, 72, 168] as const;
const DROPS = [0, 3, 5, 10] as const;
const CATEGORIES = ["below_price", "below_typical"] as const;

async function token(next: string): Promise<string> {
  const value = await sessionToken();
  if (!value) redirect(`/login?next=${next}`);
  return value;
}

function result(r: { ok: boolean; status?: number; code?: string }, next: string): FormState {
  if (r.ok) {
    revalidatePath("/account", "layout");
    return { status: "ok" };
  }
  if (r.status === 401) redirect(`/login?next=${next}`);
  return { status: "error", code: r.code === "http_422" ? "invalid_input" : r.code };
}

function hour(value: FormDataEntryValue | null): number | null {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
}

function oneOf<T extends number>(value: FormDataEntryValue | null, options: readonly T[]): T {
  return options.find((o) => String(o) === String(value)) ?? options[0];
}

/** Налаштування сповіщень (10.8): галочки — увімкнені канали й категорії. */
export async function saveNotifyPrefs(_: FormState, form: FormData): Promise<FormState> {
  const enabled = form.getAll("category").map(String);
  const start = hour(form.get("quiet_start"));
  const end = hour(form.get("quiet_end"));
  const quiet = start !== null && end !== null && start !== end;
  const timezone = String(form.get("timezone") ?? "").slice(0, 64) || null;
  const prefs: NotifyPrefs = {
    email: form.get("email") === "1",
    telegram: form.get("telegram") === "1",
    min_interval_hours: oneOf(form.get("interval"), INTERVALS),
    min_drop_percent: oneOf(form.get("drop"), DROPS),
    quiet_start: quiet ? start : null,
    quiet_end: quiet ? end : null,
    timezone: quiet ? timezone : null,
    muted: CATEGORIES.filter((c) => !enabled.includes(c)),
  };
  const next = "/account/alerts";
  return result(
    await call<Account>("PUT", "/account/notifications", prefs, await token(next)),
    next,
  );
}

const SECURITY = "/account/security";

export async function endSession(form: FormData): Promise<void> {
  const id = String(form.get("id") ?? "");
  const current = form.get("current") === "1";
  await call(
    "DELETE",
    `/account/sessions/${encodeURIComponent(id)}`,
    undefined,
    await token(SECURITY),
  );
  if (current) {
    await clearSession();
    redirect("/");
  }
  revalidatePath(SECURITY);
}

export async function endOtherSessions(): Promise<FormState> {
  return result(
    await call("POST", "/account/sessions/end-others", undefined, await token(SECURITY)),
    SECURITY,
  );
}

/** Розмови з помічником на сервері (якщо була синхронізація); браузер чистить сам. */
export async function clearServerChats(): Promise<FormState> {
  return result(await call("DELETE", "/account/chats", undefined, await token(SECURITY)), SECURITY);
}
