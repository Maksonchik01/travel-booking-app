"use client";

import { Loader2, UploadCloud, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { importGuestData } from "@/app/actions/guest-import";
import { Button } from "@/components/ui/button";
import { readLocalFavorites, toBody, writeLocalFavorites } from "@/lib/favorites";
import { readGuestSearches, writeGuestSearches } from "@/lib/guest-searches";
import { readLocalTrips, savedBody, writeLocalTrips } from "@/lib/saved-trips";

const DISMISSED_KEY = "tickets.guestImport.dismissed";

type Counts = { favorites: number; trips: number; searches: number };

/**
 * Після входу (етап 7, ADR 0051): збережене гостем у цьому браузері — обране, поїздки, пошуки —
 * пропонуємо перенести в акаунт, а не переносимо мовчки. API пропускає повтори (без дублікатів);
 * локальне стираємо лише після успіху. «Не зараз» — до кінця сесії вкладки.
 */
export function GuestImportPrompt() {
  const t = useTranslations("guestImport");
  const [counts, setCounts] = useState<Counts | null>(null);
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");

  useEffect(() => {
    try {
      if (sessionStorage.getItem(DISMISSED_KEY)) return;
    } catch {
      // без сховища — просто показуємо
    }
    const next = {
      favorites: readLocalFavorites().length,
      trips: readLocalTrips().length,
      searches: readGuestSearches().length,
    };
    // Що лежить у сховищі браузера — відомо лише після гідратації.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (next.favorites + next.trips + next.searches > 0) setCounts(next);
  }, []);

  if (!counts) return null;

  function dismiss() {
    try {
      sessionStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // нічого
    }
    setCounts(null);
  }

  async function move() {
    setState("busy");
    const favorites = readLocalFavorites();
    const trips = readLocalTrips();
    const searches = readGuestSearches();
    try {
      const result = await importGuestData({
        favorites: favorites.map(toBody),
        trips: trips.map(savedBody),
        searches,
      });
      if (!result.ok) {
        setState("error");
        return;
      }
    } catch {
      setState("error");
      return;
    }
    writeLocalFavorites([]);
    writeLocalTrips([]);
    writeGuestSearches([]);
    window.location.reload();
  }

  return (
    <div
      className="bg-card fixed inset-x-3 top-[calc(3.75rem+env(safe-area-inset-top,0px))] z-50 mx-auto grid max-w-xl gap-2 rounded-xl border p-4 shadow-xl sm:inset-x-auto sm:right-4"
      role="dialog"
      aria-labelledby="guest-import-title"
      data-testid="guest-import"
    >
      <div className="flex items-start justify-between gap-3">
        <p id="guest-import-title" className="flex items-center gap-2 text-sm font-semibold">
          <UploadCloud className="text-primary size-4 shrink-0" aria-hidden />
          {t("title")}
        </p>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t("close")}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <p className="text-muted-foreground text-xs">
        {t("body", {
          favorites: counts.favorites,
          trips: counts.trips,
          searches: counts.searches,
        })}
      </p>
      {state === "error" && (
        <p className="text-destructive text-xs" role="alert">
          {t("failed")}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => void move()}
          disabled={state === "busy"}
          data-testid="guest-import-move"
        >
          {state === "busy" && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          {t("move")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={dismiss}>
          {t("later")}
        </Button>
      </div>
      <p className="text-muted-foreground text-[11px]">{t("hint")}</p>
    </div>
  );
}
