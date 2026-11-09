"use server";

import type { FavoriteBody, FavoriteOut } from "@tickets/shared";

import { call, sessionToken } from "@/lib/session";

/** Відповідь для клієнта: без входу — `signedIn: false` (UI тримає обране в браузері). */
export type FavoritesState =
  { signedIn: false } | { signedIn: true; ok: boolean; items: FavoriteOut[]; code?: string };

/**
 * Обране акаунта. Якщо в браузері гостя щось лишилось — спершу переносимо в профіль
 * (повтори API пропускає), тоді `imported: true` і клієнт чистить локальне.
 */
export async function loadFavorites(
  local: FavoriteBody[],
): Promise<FavoritesState & { imported?: boolean }> {
  if (!(await sessionToken())) return { signedIn: false };
  let imported = false;
  if (local.length) {
    const result = await call<FavoriteOut[]>("POST", "/account/favorites/import", {
      items: local,
    });
    imported = result.ok;
  }
  const result = await call<FavoriteOut[]>("GET", "/account/favorites");
  if (!result.ok && result.status === 401) return { signedIn: false };
  return result.ok
    ? { signedIn: true, ok: true, items: result.data, imported }
    : { signedIn: true, ok: false, items: [], code: result.code, imported };
}

export async function addFavorite(body: FavoriteBody): Promise<FavoritesState> {
  if (!(await sessionToken())) return { signedIn: false };
  const result = await call<FavoriteOut[]>("POST", "/account/favorites", body);
  if (!result.ok && result.status === 401) return { signedIn: false };
  return result.ok
    ? { signedIn: true, ok: true, items: result.data }
    : { signedIn: true, ok: false, items: [], code: result.code };
}

export async function removeFavorite(itemKey: string): Promise<FavoritesState> {
  if (!(await sessionToken())) return { signedIn: false };
  const result = await call(
    "DELETE",
    `/account/favorites?${new URLSearchParams({ key: itemKey })}`,
  );
  if (!result.ok && result.status === 401) return { signedIn: false };
  return { signedIn: true, ok: result.ok, items: [] };
}
