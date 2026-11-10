"use client";

import { track } from "@/lib/analytics";
import type { FavoriteBody, FavoriteKind, FavoriteOut } from "@tickets/shared";
import {
  BedDouble,
  Compass,
  Heart,
  Loader2,
  Luggage,
  Plane,
  Search,
  Sparkles,
  Star,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { createContext, useContext, useEffect, useState } from "react";

import { addFavorite, loadFavorites, removeFavorite } from "@/app/actions/favorites";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  type FavoriteItem,
  MAX_FAVORITES,
  bodyKey,
  readLocalFavorites,
  writeLocalFavorites,
} from "@/lib/favorites";
import { localDate, localTime } from "@/lib/format";
import { toTripParams } from "@/lib/trip-params";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";
import { fractionDigits } from "@/lib/money";

type Favorites = {
  /** null — ще завантажується (кнопки неактивні, щоб не задублювати). */
  signedIn: boolean | null;
  items: FavoriteItem[];
  error: string | null;
  has: (key: string) => boolean;
  toggle: (body: FavoriteBody) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

const FavoritesContext = createContext<Favorites | null>(null);

const fromAccount = (items: FavoriteOut[]): FavoriteItem[] =>
  items.map((f) => ({
    item_key: f.item_key,
    kind: f.kind,
    created_at: f.created_at,
    stay: f.stay,
    flight: f.flight,
    trip: f.trip as FavoriteItem["trip"],
    destination: f.destination as FavoriteItem["destination"],
  }));

/**
 * Обране (модулі 7 і 10a): з акаунтом — у профілі (локальне гостя переноситься туди після
 * входу), без нього — у localStorage цього браузера. Три категорії: квитки, житло, поїздки.
 */
export function FavoritesProvider({ children }: { children: React.ReactNode }) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [items, setItems] = useState<FavoriteItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const local = readLocalFavorites();
    let cancelled = false;
    // Перенесення локального в акаунт — лише на згоду (`GuestImportPrompt`, етап 7).
    loadFavorites([])
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

  async function toggle(body: FavoriteBody) {
    const key = bodyKey(body);
    if (has(key)) return remove(key);
    setError(null);
    track("favorite_added", { kind: body.kind ?? "stay" });
    if (signedIn) {
      const state = await addFavorite(body);
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
    const item: FavoriteItem = {
      item_key: key,
      kind: body.kind ?? "stay",
      created_at: new Date().toISOString(),
      stay: body.stay,
      flight: body.flight,
      trip: body.trip,
      destination: body.destination,
    };
    const next = [item, ...items];
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

/** «В обране» для будь-якої категорії (житло, квиток, поїздка). */
export function FavoriteToggle({
  body,
  compact = false,
}: {
  body: FavoriteBody;
  compact?: boolean;
}) {
  const t = useTranslations("favorites");
  const { signedIn, has, toggle, error } = useFavorites();
  const [busy, setBusy] = useState(false);
  // Картки гідратуються пізніше за провайдер (Suspense): до гідратації — як на сервері,
  // інакше атрибути розійдуться, а React їх не виправляє.
  const hydrated = useHydrated();
  const saved = hydrated && has(bodyKey(body));
  return (
    <>
      <Button
        type="button"
        variant={saved ? "secondary" : "outline"}
        size="sm"
        className={compact ? "w-full" : undefined}
        aria-pressed={saved}
        disabled={!hydrated || signedIn === null || busy}
        onClick={async () => {
          setBusy(true);
          try {
            await toggle(body);
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

const CATEGORIES: readonly ("all" | FavoriteKind)[] = [
  "all",
  "flight",
  "stay",
  "trip",
  "destination",
];
const CATEGORY_ICON = {
  all: Heart,
  flight: Plane,
  stay: BedDouble,
  trip: Luggage,
  destination: Compass,
} as const;
const FIND_HREF = {
  all: "/",
  flight: "/",
  stay: "/stays",
  trip: "/trip",
  destination: "/explore",
} as const;

/**
 * Список обраного за категоріями: ціна знімка з датою (історична), «Повторити пошук» з
 * актуальними цінами, перенесення в планувальник, видалення.
 */
export function FavoritesList() {
  const t = useTranslations("favorites");
  const { signedIn, items, remove, error } = useFavorites();
  const [category, setCategory] = useState<"all" | FavoriteKind>("all");

  if (signedIn === null) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t("loading")}
      </p>
    );
  }
  const shown = items.filter((i) => category === "all" || i.kind === category);
  return (
    <div className="grid gap-4">
      <p className="text-muted-foreground text-sm">
        {signedIn ? t("whereAccount") : t("whereBrowser")}
      </p>
      <div role="tablist" aria-label={t("categories")} className="flex flex-wrap gap-1.5">
        {CATEGORIES.map((c) => {
          const Icon = CATEGORY_ICON[c];
          const count = c === "all" ? items.length : items.filter((i) => i.kind === c).length;
          return (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={category === c}
              onClick={() => setCategory(c)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors",
                category === c
                  ? "border-primary bg-primary text-primary-foreground"
                  : "hover:border-primary/50",
              )}
              data-testid={`favorites-tab-${c}`}
            >
              <Icon className="size-3.5" aria-hidden />
              {t(`category.${c}`)} ({count})
            </button>
          );
        })}
      </div>
      {error && (
        <p className="text-destructive text-sm" role="status">
          {t("failed")}
        </p>
      )}
      {shown.length === 0 ? (
        <p
          className="bg-card rounded-xl border p-6 text-center text-sm"
          data-testid="favorites-empty"
        >
          {t("empty")}{" "}
          <Link href={FIND_HREF[category]} className="text-primary font-medium underline">
            {t(`find.${category}`)}
          </Link>
        </p>
      ) : (
        <ul className="grid gap-3" data-testid="favorites-list">
          {shown.map((item) => (
            <li key={item.item_key}>
              <FavoriteCard item={item} onRemove={() => remove(item.item_key)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type View = {
  kindLabel: string;
  title: string;
  details: React.ReactNode;
  total: string;
  at: string;
  actions: { href: string; label: string; icon: typeof Search }[];
};

function FavoriteCard({ item, onRemove }: { item: FavoriteItem; onRemove: () => void }) {
  const t = useTranslations("favorites");
  const tCard = useTranslations("stayCard");
  const tOffer = useTranslations("offer");
  const format = useFormatter();
  const day = (iso: string) =>
    format.dateTime(new Date(`${iso.slice(0, 10)}T00:00:00Z`), {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  const money = (value: number | string, currency: string) =>
    format.number(Number(value), {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      ...fractionDigits(Number(value)),
    });
  const priceAt = (iso: string) =>
    t("priceAt", {
      date: format.dateTime(new Date(iso), {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }),
    });

  let view: View;
  if (item.kind === "flight" && item.flight) {
    const f = item.flight;
    view = {
      kindLabel: t("category.flight"),
      title: `${f.origin} → ${f.destination}`,
      details: (
        <>
          <p className="text-sm tabular-nums">
            {day(localDate(f.departure_at))} {localTime(f.departure_at)}
            {f.arrival_at ? `–${localTime(f.arrival_at)}` : ""}
            {f.return_departure_at &&
              ` · ${t("back")} ${day(localDate(f.return_departure_at))} ${localTime(f.return_departure_at)}`}
          </p>
          <p className="text-muted-foreground text-xs">
            {[
              f.airlines.join(", "),
              f.stops === 0 ? tOffer("direct") : tOffer("stops", { count: f.stops }),
              t("passengers", { count: f.passengers ?? 1 }),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </>
      ),
      total: money(f.price, f.currency),
      at: priceAt(f.price_at),
      actions: [
        { href: `/?${f.params}`, label: t("refresh"), icon: Search },
        ...(f.return_departure_at
          ? [
              {
                href: `/trip?${new URLSearchParams({
                  from: f.origin,
                  to: f.destination,
                  depart: localDate(f.departure_at),
                  return: localDate(f.return_departure_at),
                  adults: String(f.passengers ?? 1),
                  flight: `${f.source}:${f.offer_id}`,
                })}`,
                label: t("toPlanner"),
                icon: Sparkles,
              },
            ]
          : []),
      ],
    };
  } else if (item.kind === "destination" && item.destination) {
    const d = item.destination;
    view = {
      kindLabel: `${t("category.destination")}${d.country ? ` · ${d.country}` : ""}`,
      title: d.city,
      details: (
        <p className="text-sm">
          {day(d.depart)} – {day(d.back)}
          <span className="text-muted-foreground">
            {" · "}
            {d.with_stay ? t("destinationWithStay") : t("destinationFlight")}
          </span>
        </p>
      ),
      total: money(d.price, d.currency),
      at: priceAt(d.price_at),
      actions: [
        { href: `/explore?${d.params}`, label: t("refresh"), icon: Search },
        {
          href: `/trip?${new URLSearchParams({ to: d.code, depart: d.depart, return: d.back })}`,
          label: t("toPlanner"),
          icon: Sparkles,
        },
      ],
    };
  } else if (item.kind === "trip" && item.trip) {
    const trip = item.trip;
    const s = trip.snapshot;
    view = {
      kindLabel: t("category.trip"),
      title: trip.title,
      details: (
        <p className="text-muted-foreground text-xs">
          {s.flight.origin} → {s.flight.destination} · {day(s.check_in)} – {day(s.check_out)} ·{" "}
          {s.stay.name}
        </p>
      ),
      total: money(s.money_total, s.currency),
      at: priceAt(s.priced_at),
      actions: [
        {
          href: `/trip?${toTripParams(trip.query)}`,
          label: t("openInPlanner"),
          icon: Sparkles,
        },
      ],
    };
  } else {
    const stay = item.stay!;
    view = {
      kindLabel: `${tCard(`kind.${stay.kind}`)} · ${stay.city}${stay.district ? ` · ${stay.district}` : ""}`,
      title: stay.name,
      details: (
        <>
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
        </>
      ),
      total: money(stay.total_price, stay.currency),
      at: priceAt(stay.price_at),
      actions: [
        { href: `/stays?${stay.params}`, label: t("refresh"), icon: Search },
        {
          href: `/trip?${new URLSearchParams({
            to: stay.city,
            depart: stay.check_in,
            return: stay.check_out,
            stay: `${stay.source}:${stay.stay_id}`,
          })}`,
          label: t("toPlanner"),
          icon: Sparkles,
        },
      ],
    };
  }

  return (
    <Card className="gap-2 p-4" data-testid="favorite-item" data-kind={item.kind}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <p className="text-muted-foreground text-xs">{view.kindLabel}</p>
          <h2 className="text-lg leading-tight font-semibold">{view.title}</h2>
          {view.details}
        </div>
        <div className="text-right">
          <p className="text-xl font-bold tabular-nums">{view.total}</p>
          <p className="text-muted-foreground max-w-48 text-[11px] leading-snug">{view.at}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {view.actions.map(({ href, label, icon: Icon }, i) => (
          <Button key={href} asChild size="sm" variant={i === 0 ? "default" : "outline"}>
            <Link href={href}>
              <Icon className="size-3.5" aria-hidden />
              {label}
            </Link>
          </Button>
        ))}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onRemove}
          data-testid="favorite-remove"
        >
          <Trash2 className="size-3.5" aria-hidden />
          {t("remove")}
        </Button>
      </div>
    </Card>
  );
}
