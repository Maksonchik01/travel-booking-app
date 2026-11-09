"use client";

import type { TripSnapshotInput } from "@tickets/shared";
import { Columns3, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { createContext, useContext, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { localDate, localTime, splitDuration } from "@/lib/format";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";
import { fractionDigits } from "@/lib/money";

export const MAX_TRIP_COMPARE = 3;
const STORAGE_KEY = "tickets.tripCompare.v1";
const CHANGED_EVENT = "trip-compare:changed";

/**
 * Додати поїздки до порівняння ззовні провайдера (з чату, модуль 9a): у сховище вкладки й
 * подія — відкриті панелі перечитують його. Понад MAX_TRIP_COMPARE — найстаріші випадають.
 */
export function addToTripCompare(items: TripCompareItem[]): void {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]") as TripCompareItem[];
    const keys = new Set(items.map((i) => i.key));
    const next = [...(Array.isArray(saved) ? saved : []).filter((i) => !keys.has(i.key)), ...items];
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next.slice(-MAX_TRIP_COMPARE)));
    window.dispatchEvent(new Event(CHANGED_EVENT));
  } catch {
    // Немає сховища — порівняння з чату недоступне.
  }
}

export type TripCompareItem = { key: string; title: string; snapshot: TripSnapshotInput };

type Compare = {
  items: TripCompareItem[];
  toggle: (item: TripCompareItem) => void;
  remove: (key: string) => void;
  clear: () => void;
};

const TripCompareContext = createContext<Compare | null>(null);

/**
 * Порівняння до трьох готових поїздок (8.6): сценарії, «Ваша поїздка», збережені. Вибір —
 * у sessionStorage вкладки (переживає переходи між пошуком і «Моїми поїздками»).
 */
export function TripCompareProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<TripCompareItem[]>([]);
  const loaded = useRef(false);

  useEffect(() => {
    const load = () => {
      try {
        const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]") as TripCompareItem[];
        if (Array.isArray(saved)) setItems(saved.slice(0, MAX_TRIP_COMPARE));
      } catch {
        // Немає сховища — порівняння лише до перезавантаження.
      }
    };
    // Відновлення зі сховища браузера — після гідратації і коли чат додав поїздки.
    load();
    loaded.current = true;
    window.addEventListener(CHANGED_EVENT, load);
    return () => window.removeEventListener(CHANGED_EVENT, load);
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
          : prev.length < MAX_TRIP_COMPARE
            ? [...prev, item]
            : prev,
      ),
    remove: (key) => setItems((prev) => prev.filter((i) => i.key !== key)),
    clear: () => setItems([]),
  };
  return <TripCompareContext.Provider value={value}>{children}</TripCompareContext.Provider>;
}

function useTripCompare(): Compare {
  const ctx = useContext(TripCompareContext);
  if (!ctx) throw new Error("TripCompareProvider is missing");
  return ctx;
}

export function TripCompareToggle({ item }: { item: TripCompareItem }) {
  const t = useTranslations("tripCompare");
  const { items, toggle } = useTripCompare();
  // До гідратації — як на сервері (картки гідратуються пізніше за провайдер).
  const hydrated = useHydrated();
  const selected = hydrated && items.some((i) => i.key === item.key);
  const full = hydrated && !selected && items.length >= MAX_TRIP_COMPARE;
  return (
    <Button
      type="button"
      variant={selected ? "secondary" : "outline"}
      size="sm"
      aria-pressed={selected}
      disabled={!hydrated || full}
      title={full ? t("full", { max: MAX_TRIP_COMPARE }) : undefined}
      onClick={() => toggle(item)}
      data-testid="trip-compare-toggle"
    >
      <Columns3 className="size-3.5" aria-hidden />
      {selected ? t("added") : t("add")}
    </Button>
  );
}

export function TripCompareBar() {
  const t = useTranslations("tripCompare");
  const { items, clear } = useTripCompare();
  const dialog = useRef<HTMLDialogElement>(null);
  if (items.length === 0) return null;
  return (
    <>
      <div
        className="bg-card/95 fixed inset-x-0 bottom-0 z-40 border-t shadow-lg backdrop-blur"
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
        data-testid="trip-compare-bar"
      >
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
          <span className="font-medium">
            {t("selected", { count: items.length, max: MAX_TRIP_COMPARE })}
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
              data-testid="trip-compare-open"
              data-track="compare_opened"
              data-track-kind="trip"
            >
              {t("open")}
            </Button>
          </div>
        </div>
      </div>
      <dialog
        ref={dialog}
        className="bg-card text-card-foreground m-auto w-[min(60rem,calc(100vw-2rem))] rounded-xl border p-0 shadow-2xl backdrop:bg-black/40"
        aria-labelledby="trip-compare-title"
        data-testid="trip-compare-dialog"
      >
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <h2 id="trip-compare-title" className="font-semibold">
            {t("title")}
          </h2>
          <Button type="button" variant="ghost" size="sm" onClick={() => dialog.current?.close()}>
            <X className="size-4" aria-hidden />
            <span className="sr-only">{t("close")}</span>
          </Button>
        </div>
        <div className="overflow-x-auto p-4">
          <CompareTable onEmpty={() => dialog.current?.close()} />
          <p className="text-muted-foreground mt-3 text-[11px]">{t("note")}</p>
        </div>
      </dialog>
    </>
  );
}

/** Днів у дорозі: від дати вильоту туди до дати прильоту назад (місцеві дати) включно. */
export function tripDays(s: TripSnapshotInput): number {
  const end = localDate(s.flight.return_arrival_at ?? s.flight.return_departure_at);
  const start = localDate(s.flight.departure_at);
  return (
    Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1
  );
}

function CompareTable({ onEmpty }: { onEmpty: () => void }) {
  const t = useTranslations("tripCompare");
  const tStay = useTranslations("stayCard");
  const format = useFormatter();
  const { items, remove } = useTripCompare();
  if (items.length === 0) return null;
  const snaps = items.map((i) => i.snapshot);
  const num = (v: number | string) => Number(v);
  const money = (s: TripSnapshotInput, value: number | string) =>
    format.number(num(value), {
      style: "currency",
      currency: s.currency,
      currencyDisplay: "narrowSymbol",
      ...fractionDigits(num(value)),
    });
  const best = {
    total: Math.min(...snaps.map((s) => num(s.money_total))),
    flight: Math.min(...snaps.map((s) => s.flight.duration_min ?? Infinity)),
    stops: Math.min(...snaps.map((s) => s.flight.stops)),
    rating: Math.max(...snaps.map((s) => s.stay.rating ?? -1)),
  };
  const good = "font-medium text-success";
  const duration = (minutes: number | null | undefined) => {
    if (minutes == null) return t("unknown");
    const { hours, minutes: mins } = splitDuration(minutes);
    return t("duration", { hours, minutes: String(mins).padStart(2, "0") });
  };

  const rows: [string, (s: TripSnapshotInput) => React.ReactNode][] = [
    [
      t("total"),
      (s) => (
        <span
          className={cn("font-semibold tabular-nums", num(s.money_total) === best.total && good)}
        >
          {money(s, s.money_total)}
          {s.unknown > 0 && (
            <span className="text-muted-foreground block text-[11px] font-normal">
              {t("plusUnknown", { count: s.unknown })}
            </span>
          )}
        </span>
      ),
    ],
    [t("flights"), (s) => money(s, s.flight.price)],
    [t("stay"), (s) => money(s, s.stay.total_price)],
    [t("tripLength"), (s) => t("days", { days: tripDays(s), nights: s.nights })],
    [
      t("flightTime"),
      (s) => (
        <span className={cn(s.flight.duration_min === best.flight && good)}>
          {duration(s.flight.duration_min)}
        </span>
      ),
    ],
    [
      t("stops"),
      (s) => (
        <span className={cn(s.flight.stops === best.stops && good)}>
          {s.flight.stops === 0 ? t("direct") : t("stopsCount", { count: s.flight.stops })}
        </span>
      ),
    ],
    [
      t("times"),
      (s) =>
        `${localTime(s.flight.departure_at)} ${s.flight.origin} / ${localTime(s.flight.return_departure_at)} ${s.flight.destination}`,
    ],
    [
      t("rating"),
      (s) =>
        s.stay.rating == null ? (
          t("unknown")
        ) : (
          <span className={cn(s.stay.rating === best.rating && good)}>
            {format.number(s.stay.rating, { maximumFractionDigits: 1 })} ·{" "}
            {tStay("reviews", { count: s.stay.review_count ?? 0 })}
          </span>
        ),
    ],
    [
      t("location"),
      (s) =>
        [
          s.stay.district,
          s.stay.distance_to_center_km != null
            ? t("km", { km: format.number(s.stay.distance_to_center_km) })
            : null,
        ]
          .filter(Boolean)
          .join(" · ") || t("unknown"),
    ],
    [t("cancellation"), (s) => tStay(`cancellation.${s.stay.cancellation ?? "unknown"}`)],
    [
      t("pricedAt"),
      (s) =>
        format.dateTime(new Date(s.priced_at), {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        }),
    ],
  ];

  return (
    <table
      className="w-full min-w-[34rem] border-separate border-spacing-0 text-sm"
      data-testid="trip-compare-table"
    >
      <thead>
        <tr>
          <th scope="col" className="w-36" />
          {items.map((item) => (
            <th key={item.key} scope="col" className="border-b p-2 text-left align-bottom">
              <div className="flex items-start justify-between gap-2">
                <span className="font-semibold">{item.title}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    remove(item.key);
                    if (items.length === 1) onEmpty();
                  }}
                  aria-label={t("remove")}
                >
                  <X className="size-3.5" aria-hidden />
                </Button>
              </div>
              <span className="text-muted-foreground block text-xs font-normal">
                {item.snapshot.stay.name}
              </span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, cell]) => (
          <tr key={label}>
            <th
              scope="row"
              className="text-muted-foreground border-b p-2 text-left text-xs font-medium"
            >
              {label}
            </th>
            {items.map((item) => (
              <td key={item.key} className="border-b p-2 align-top">
                {cell(item.snapshot)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
