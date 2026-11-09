"use server";

import type { SavedTrip, SavedTripBody, SavedTripPatch } from "@tickets/shared";

import { call, sessionToken } from "@/lib/session";

/** Без входу — `signedIn: false`: UI тримає поїздки в браузері. */
export type TripsState =
  { signedIn: false } | { signedIn: true; ok: boolean; items: SavedTrip[]; code?: string };

type One = { signedIn: false } | { signedIn: true; ok: boolean; item?: SavedTrip; code?: string };

/** Поїздки акаунта; локальні гостя спершу переносимо в профіль (`imported: true`). */
export async function loadSavedTrips(
  local: SavedTripBody[],
): Promise<TripsState & { imported?: boolean }> {
  if (!(await sessionToken())) return { signedIn: false };
  let imported = false;
  if (local.length) {
    imported = (await call("POST", "/account/trips/import", { items: local })).ok;
  }
  const result = await call<SavedTrip[]>("GET", "/account/trips");
  if (!result.ok && result.status === 401) return { signedIn: false };
  return result.ok
    ? { signedIn: true, ok: true, items: result.data, imported }
    : { signedIn: true, ok: false, items: [], code: result.code, imported };
}

async function one(method: "POST" | "PUT" | "PATCH", path: string, body: unknown): Promise<One> {
  if (!(await sessionToken())) return { signedIn: false };
  const result = await call<SavedTrip>(method, path, body);
  if (!result.ok && result.status === 401) return { signedIn: false };
  return result.ok
    ? { signedIn: true, ok: true, item: result.data }
    : { signedIn: true, ok: false, code: result.code };
}

export async function createSavedTrip(body: SavedTripBody): Promise<One> {
  return one("POST", "/account/trips", body);
}

export async function updateSavedTrip(id: string, body: SavedTripBody): Promise<One> {
  return one("PUT", `/account/trips/${encodeURIComponent(id)}`, body);
}

/** Назва та/або статус (чернетка / запланована / архівна). */
export async function patchSavedTrip(id: string, patch: SavedTripPatch): Promise<One> {
  return one("PATCH", `/account/trips/${encodeURIComponent(id)}`, patch);
}

export async function deleteSavedTrip(id: string): Promise<{ signedIn: boolean; ok: boolean }> {
  if (!(await sessionToken())) return { signedIn: false, ok: false };
  const result = await call("DELETE", `/account/trips/${encodeURIComponent(id)}`);
  if (!result.ok && result.status === 401) return { signedIn: false, ok: false };
  return { signedIn: true, ok: result.ok };
}
