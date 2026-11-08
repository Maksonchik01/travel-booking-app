"use client";

import type { FavoriteOut, FavoriteStayInput } from "@tickets/shared";
import { Heart, Loader2, Search, Star, Trash2 } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { createContext, useContext, useEffect, useState } from "react";

import { addFavorite, loadFavorites, removeFavorite } from "@/app/actions/favorites";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  type FavoriteItem,
  MAX_FAVORITES,
  favoriteKey,
  readLocalFavorites,
  writeLocalFavorites,
} from "@/lib/favorites";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";

type Favorites = {
  /** null — ще завантажується (кнопки неактивні, щоб не задублювати). */
  signedIn: boolean | null;
  items: FavoriteItem[];
  error: string | null;
  has: (key: string) => boolean;
  toggle: (stay: FavoriteStayInput) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

const FavoritesContext = createContext<Favorites | null>(null);

const fromAccount = (items: FavoriteOut[]): FavoriteItem[] =>
  items.map((f) => ({ item_key: f.item_key, created_at: f.created_at, stay: f.stay }));

/**
 * Обране (модуль 7): з акаунтом — у профілі (локальне гостя переноситься туди після входу),
 * без нього — у localStorage цього браузера.
 */
export function FavoritesProvider({ children }: { children: React.ReactNode }) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [items, setItems] = useState<FavoriteItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const local = readLocalFavorites();
    let cancelled = false;
    loadFavorites(local.map((i) => i.stay))
      .then((state) => {
        if (cancelled) return;
        if (!state.signedIn) {
          setSignedIn(false);
          setItems(local);
          return;
        }
        setSignedIn(true);
        if (state.imported) writeLocalFavorites([]);
        setItems(state.ok ? fromAccount(state.items) : local);
        if (!state.ok) setError(state.code ?? "error");
      })
      .catch(() => {
        // Сервер недоступний — працюємо з тим, що в браузері.
        if (cancelled) return;
        setSignedIn(false);
        setItems(local);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const has = (key: string) => items.some((i) => i.item_key === key);

  async function remove(key: string) {
    setError(null);
    const next = items.filter((i) => i.item_key !== key);
    if (signedIn) {
      const state = await removeFavorite(key);
      if (state.signedIn && !state.ok) {
        setError("error");
        return;
      }
    } else {
      writeLocalFavorites(next);
    }
    setItems(next);
  }

  async function toggle(stay: FavoriteStayInput) {
    const key = favoriteKey(stay);
    if (has(key)) return remove(key);
    setError(null);
    if (signedIn) {
      const state = await addFavorite(stay);
      if (state.signedIn) {
        if (state.ok) setItems(fromAccount(state.items));
        else setError(state.code ?? "error");
        return;
      }
      setSignedIn(false); // сесія закінчилась — зберігаємо як гість
    }
    if (items.length >= MAX_FAVORITES) {
      setError("limit_reached");
      return;
    }
    const next = [{ item_key: key, created_at: new Date().toISOString(), stay }, ...items];
    writeLocalFavorites(next);
    setItems(next);
  }

  return (
    <FavoritesContext.Provider value={{ signedIn, items, error, has, toggle, remove }}>
      {children}
    </FavoritesContext.Provider>
  );
}

function useFavorites(): Favorites {
  const ctx = useContext(FavoritesContext);
  if (!ctx) throw new Error("FavoritesProvider is missing");
  return ctx;
}

/** «В обране» в картці житла. */
export function FavoriteToggle({ stay }: { stay: FavoriteStayInput }) {
  const t = useTranslations("favorites");
  const { signedIn, has, toggle, error } = useFavorites();
  const [busy, setBusy] = useState(false);
  // Картки гідратуються пізніше за провайдер (Suspense): до гідратації — як на сервері,
  // інакше атрибути розійдуться, а React їх не виправляє.
  const hydrated = useHydrated();
  const saved = hydrated && has(favoriteKey(stay));
  return (
    <>
      <Button
        type="button"
        variant={saved ? "secondary" : "outline"}
        size="sm"
        aria-pressed={saved}
        disabled={!hydrated || signedIn === null || busy}
        onClick={async () => {
          setBusy(true);
          try {
            await toggle(stay);
          } finally {
            setBusy(false);
          }
        }}
        data-testid="favorite-toggle"
      >
        {busy ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <Heart className={cn("size-3.5", saved && "fill-rose-500 text-rose-500")} aria-hidden />
        )}
        {saved ? t("saved") : t("add")}
      </Button>
      {error && (
        <span className="text-destructive basis-full text-xs" role="status">
          {t(error === "limit_reached" ? "limit" : "failed", { max: MAX_FAVORITES })}
        </span>
      )}
    </>
  );
}

/** Сторінка «Обране»: знімки з датою ціни, «Відкрити пошук» з актуальними цінами, видалення. */
export function FavoritesList() {
  const t = useTranslations("favorites");
  const tCard = useTranslations("stayCard");
  const format = useFormatter();
  const { signedIn, items, remove, error } = useFavorites();

  if (signedIn === null) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t("loading")}
      </p>
    );
  }
  const day = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });

  return (
    <div className="grid gap-4">
      <p className="text-muted-foreground text-sm">
        {signedIn ? t("whereAccount") : t("whereBrowser")}
      </p>
      {error && (
        <p className="text-destructive text-sm" role="status">
          {t("failed")}
        </p>
      )}
      {items.length === 0 ? (
        <p
          className="bg-card rounded-xl border p-6 text-center text-sm"
          data-testid="favorites-empty"
        >
          {t("empty")}{" "}
          <Link href="/stays" className="text-primary font-medium underline">
            {t("findStays")}
          </Link>
        </p>
      ) : (
        <ul className="grid gap-3" data-testid="favorites-list">
          {items.map(({ item_key, stay }) => (
            <li key={item_key}>
              <Card className="gap-2 p-4" data-testid="favorite-item">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="grid gap-1">
                    <p className="text-muted-foreground text-xs">
                      {tCard(`kind.${stay.kind}`)} · {stay.city}
                      {stay.district ? ` · ${stay.district}` : ""}
                    </p>
                    <h2 className="text-lg leading-tight font-semibold">{stay.name}</h2>
                    <p className="text-sm">
                      {day(stay.check_in)} – {day(stay.check_out)}
                    </p>
                    {stay.rating != null && (
                      <p className="flex items-center gap-1 text-xs">
                        <Star className="size-3 fill-amber-400 text-amber-400" aria-hidden />
                        {format.number(stay.rating, { maximumFractionDigits: 1 })}
                        <span className="text-muted-foreground">
                          · {tCard("reviews", { count: stay.review_count ?? 0 })}
                        </span>
                      </p>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="text-xl font-bold tabular-nums">
                      {format.number(Number(stay.total_price), {
                        style: "currency",
                        currency: stay.currency,
                        currencyDisplay: "narrowSymbol",
                        maximumFractionDigits: 0,
                      })}
                    </p>
                    <p className="text-muted-foreground max-w-48 text-[11px] leading-snug">
                      {t("priceAt", {
                        date: format.dateTime(new Date(stay.price_at), {
                          day: "numeric",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        }),
                      })}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button asChild size="sm">
                    <Link href={`/stays?${stay.params}`}>
                      <Search className="size-3.5" aria-hidden />
                      {t("refresh")}
                    </Link>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => remove(item_key)}
                    data-testid="favorite-remove"
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                    {t("remove")}
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
