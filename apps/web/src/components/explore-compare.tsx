"use client";

import { Columns3, X } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { createContext, useContext, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { splitDuration } from "@/lib/format";
import { fractionDigits } from "@/lib/money";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";

export const MAX_EXPLORE_COMPARE = 3;
const STORAGE_KEY = "tickets.exploreCompare.v1";

/** Знімок напрямку для порівняння: лише те, що показуємо поруч (sessionStorage вкладки). */
export type ExploreCompareItem = {
  key: string;
  city: string;
  country: string;
  depart: string;
  back: string;
  nights: number;
  currency: string;
  flight: number;
  /** null — житло не перевіряли чи не знайшли. */
  stay: number | null;
  stayName: string | null;
  total: number | null;
  /** Туди й назад, хв; null — невідомо (кешовані ціни з пересадками). */
  flightMinutes: number | null;
  stops: number;
  flightsHref: string;
  tripHref: string;
};

type Compare = {
  items: ExploreCompareItem[];
  toggle: (item: ExploreCompareItem) => void;
  remove: (key: string) => void;
  clear: () => void;
};

const ExploreCompareContext = createContext<Compare | null>(null);

/** Порівняння до трьох напрямків Explore (ADR 0045) — як порівняння поїздок (8.6). */
export function ExploreCompareProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ExploreCompareItem[]>([]);
  const loaded = useRef(false);

  useEffect(() => {
    const load = () => {
      try {
        const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
        if (Array.isArray(saved)) setItems(saved.slice(0, MAX_EXPLORE_COMPARE));
      } catch {
        // Немає сховища — порівняння лише до перезавантаження.
      }
    };
    // Відновлення зі сховища браузера — після гідратації.
    load();
    loaded.current = true;
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {
      // Приватний режим — без збереження.
    }
  }, [items]);

  const value: Compare = {
    items,
    toggle: (item) =>
      setItems((prev) =>
        prev.some((i) => i.key === item.key)
          ? prev.filter((i) => i.key !== item.key)
          : prev.length < MAX_EXPLORE_COMPARE
            ? [...prev, item]
            : prev,
      ),
    remove: (key) => setItems((prev) => prev.filter((i) => i.key !== key)),
    clear: () => setItems([]),
  };
  return <ExploreCompareContext.Provider value={value}>{children}</ExploreCompareContext.Provider>;
}

function useExploreCompare(): Compare {
  const ctx = useContext(ExploreCompareContext);
  if (!ctx) throw new Error("ExploreCompareProvider is missing");
  return ctx;
}

export function ExploreCompareToggle({ item }: { item: ExploreCompareItem }) {
  const t = useTranslations("explore.compare");
  const { items, toggle } = useExploreCompare();
  const hydrated = useHydrated();
  const selected = hydrated && items.some((i) => i.key === item.key);
  const full = hydrated && !selected && items.length >= MAX_EXPLORE_COMPARE;
  return (
    <Button
      type="button"
      variant={selected ? "secondary" : "outline"}
      size="sm"
      aria-pressed={selected}
      disabled={!hydrated || full}
      title={full ? t("full", { max: MAX_EXPLORE_COMPARE }) : undefined}
      onClick={() => toggle(item)}
      data-testid="explore-compare-toggle"
    >
      <Columns3 className="size-3.5" aria-hidden />
      {selected ? t("added") : t("add")}
    </Button>
  );
}

export function ExploreCompareBar() {
  const t = useTranslations("explore.compare");
  const { items, clear } = useExploreCompare();
  const dialog = useRef<HTMLDialogElement>(null);
  if (items.length === 0) return null;
  return (
    <>
      <div
        className="bg-card/95 fixed inset-x-0 bottom-0 z-40 border-t shadow-lg backdrop-blur"
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
        data-testid="explore-compare-bar"
        data-bottom-bar
      >
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
          <span className="font-medium">
            {t("selected", { count: items.length, max: MAX_EXPLORE_COMPARE })}
          </span>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={clear}>
              {t("clear")}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={items.length < 2}
              onClick={() => dialog.current?.showModal()}
              data-testid="explore-compare-open"
              data-track="compare_opened"
              data-track-kind="destination"
            >
              {t("open")}
            </Button>
          </div>
        </div>
      </div>
      <dialog
        ref={dialog}
        className="bg-card text-card-foreground m-auto max-h-[calc(100dvh-2rem)] w-[min(60rem,calc(100vw-2rem))] rounded-xl border p-0 shadow-2xl backdrop:bg-black/40"
        aria-labelledby="explore-compare-title"
        data-testid="explore-compare-dialog"
      >
        <div className="bg-card sticky top-0 flex items-center justify-between gap-2 border-b px-4 py-3">
          <h2 id="explore-compare-title" className="font-semibold">
            {t("title")}
          </h2>
          <Button type="button" variant="ghost" size="sm" onClick={() => dialog.current?.close()}>
            <X className="size-4" aria-hidden />
            <span className="sr-only">{t("close")}</span>
          </Button>
        </div>
        <div className="p-4">
          <CompareView onEmpty={() => dialog.current?.close()} />
          <p className="text-muted-foreground mt-3 text-[11px]">{t("note")}</p>
        </div>
      </dialog>
    </>
  );
}

type Row = [string, (item: ExploreCompareItem) => React.ReactNode];

/** Телефон — картка на кожен напрямок (рядки один під одним), ширше — таблиця поруч. */
function CompareView({ onEmpty }: { onEmpty: () => void }) {
  const t = useTranslations("explore.compare");
  const format = useFormatter();
  const { items, remove } = useExploreCompare();
  if (items.length === 0) return null;
  const money = (item: ExploreCompareItem, value: number) =>
    format.number(value, {
      style: "currency",
      currency: item.currency,
      currencyDisplay: "narrowSymbol",
      ...fractionDigits(value),
    });
  const sum = (item: ExploreCompareItem) => item.total ?? item.flight;
  const best = {
    total: Math.min(...items.map(sum)),
    minutes: Math.min(...items.map((i) => i.flightMinutes ?? Infinity)),
    nights: Math.max(...items.map((i) => i.nights)),
  };
  const good = "font-medium text-success";
  const date = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  const rows: Row[] = [
    [t("dates"), (i) => `${date(i.depart)} – ${date(i.back)}`],
    [t("nights"), (i) => <span className={cn(i.nights === best.nights && good)}>{i.nights}</span>],
    [t("flight"), (i) => money(i, i.flight)],
    [t("stay"), (i) => (i.stay == null ? t("stayUnknown") : money(i, i.stay))],
    [
      t("total"),
      (i) => (
        <span className={cn("font-semibold tabular-nums", sum(i) === best.total && good)}>
          {i.total == null ? t("flightOnly", { price: money(i, i.flight) }) : money(i, i.total)}
        </span>
      ),
    ],
    [
      t("flightTime"),
      (i) => {
        if (i.flightMinutes == null) return t("unknown");
        const { hours, minutes } = splitDuration(i.flightMinutes);
        return (
          <span className={cn(i.flightMinutes === best.minutes && good)}>
            {t("duration", { hours, minutes: String(minutes).padStart(2, "0") })}
          </span>
        );
      },
    ],
    [t("stops"), (i) => (i.stops === 0 ? t("direct") : t("stopsCount", { count: i.stops }))],
  ];
  const removeItem = (key: string) => {
    remove(key);
    if (items.length === 1) onEmpty();
  };
  const head = (item: ExploreCompareItem) => (
    <div className="flex items-start justify-between gap-2">
      <span>
        <span className="block font-semibold">{item.city}</span>
        <span className="text-muted-foreground block text-xs font-normal">{item.country}</span>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={() => removeItem(item.key)}
        aria-label={t("remove", { city: item.city })}
      >
        <X className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
  const actions = (item: ExploreCompareItem) => (
    <div className="flex flex-wrap gap-2">
      <Link href={item.flightsHref} className="text-primary text-xs font-medium hover:underline">
        {t("toFlights")}
      </Link>
      <Link href={item.tripHref} className="text-primary text-xs font-medium hover:underline">
        {t("toTrip")}
      </Link>
    </div>
  );

  return (
    <>
      <div className="grid gap-3 sm:hidden" data-testid="explore-compare-cards">
        {items.map((item) => (
          <div key={item.key} className="grid gap-2 rounded-lg border p-3">
            {head(item)}
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              {rows.map(([label, cell]) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="text-right tabular-nums">{cell(item)}</dd>
                </div>
              ))}
            </dl>
            {actions(item)}
          </div>
        ))}
      </div>
      <div className="hidden overflow-x-auto sm:block">
        <table
          className="w-full border-separate border-spacing-0 text-sm"
          data-testid="explore-compare-table"
        >
          <thead>
            <tr>
              <th scope="col" className="w-36" />
              {items.map((item) => (
                <th key={item.key} scope="col" className="border-b p-2 text-left align-bottom">
                  {head(item)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, cell]) => (
              <tr key={label}>
                <th
                  scope="row"
                  className="text-muted-foreground border-b p-2 text-left font-normal"
                >
                  {label}
                </th>
                {items.map((item) => (
                  <td key={item.key} className="border-b p-2 tabular-nums">
                    {cell(item)}
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <td />
              {items.map((item) => (
                <td key={item.key} className="p-2">
                  {actions(item)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
