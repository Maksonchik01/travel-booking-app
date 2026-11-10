"use server";

import type { FavoriteBody, SavedTripBody } from "@tickets/shared";

import { call, sessionToken } from "@/lib/session";
import type { GuestSearch } from "@/lib/guest-searches";

export type GuestImportResult = { ok: boolean; signedIn: boolean };

/**
 * Перенести збережене гостем у цьому браузері до акаунта (етап 7, ADR 0051) — лише на згоду
 * людини. API пропускає повтори: обране — за ключем, поїздки — за конфігурацією, пошуки — за
 * видом і параметрами. Частковий збій — `ok: false`, а локальне браузер тоді не стирає.
 */
export async function importGuestData(data: {
  favorites: FavoriteBody[];
  trips: SavedTripBody[];
  searches: GuestSearch[];
}): Promise<GuestImportResult> {
  if (!(await sessionToken())) return { ok: false, signedIn: false };
  const results = await Promise.all([
    data.favorites.length
      ? call("POST", "/account/favorites/import", { items: data.favorites })
      : Promise.resolve({ ok: true }),
    data.trips.length
      ? call("POST", "/account/trips/import", { items: data.trips })
      : Promise.resolve({ ok: true }),
    data.searches.length
      ? call("POST", "/account/saved/import", {
          items: data.searches.map(({ kind, params, title }) => ({ kind, params, title })),
        })
      : Promise.resolve({ ok: true }),
  ]);
  return { ok: results.every((r) => r.ok), signedIn: true };
}
