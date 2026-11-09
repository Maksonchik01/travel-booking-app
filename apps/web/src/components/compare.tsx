"use client";

import type { Leg, Offer } from "@tickets/shared";
import { Columns3, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { createContext, useContext, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { localTime, splitDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

export const MAX_COMPARE = 3;
const STORAGE_KEY = "tickets.compare.v1";

type Compare = {
  offers: Offer[];
  toggle: (offer: Offer) => void;
  remove: (key: string) => void;
  clear: () => void;
};

const CompareContext = createContext<Compare | null>(null);

export const compareKey = (o: Offer) => `${o.source}:${o.id}`;

/**
 * Порівняння до трьох варіантів (модуль 4.2). Вибір живе в sessionStorage вкладки: зміна
 * фільтрів чи сортування його не губить, а закрита вкладка — забуває.
 */
export function CompareProvider({ children }: { children: React.ReactNode }) {
  const [offers, setOffers] = useState<Offer[]>([]);
  const loaded = useRef(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]") as Offer[];
      // Відновлення зі сховища браузера — разово після гідратації.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (Array.isArray(saved)) setOffers(saved.slice(0, MAX_COMPARE));
    } catch {
      // Немає сховища — порівняння лише до перезавантаження.
    }
    loaded.current = true;
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(offers));
    } catch {
      // Приватний режим — без збереження.
    }
  }, [offers]);

  const value: Compare = {
    offers,
    toggle: (offer) =>
      setOffers((prev) =>
        prev.some((o) => compareKey(o) === compareKey(offer))
          ? prev.filter((o) => compareKey(o) !== compareKey(offer))
          : prev.length < MAX_COMPARE
            ? [...prev, offer]
            : prev,
      ),
    remove: (key) => setOffers((prev) => prev.filter((o) => compareKey(o) !== key)),
    clear: () => setOffers([]),
  };
  return <CompareContext.Provider value={value}>{children}</CompareContext.Provider>;
}

function useCompare(): Compare {
  const ctx = useContext(CompareContext);
  if (!ctx) throw new Error("CompareProvider is missing");
  return ctx;
}

/** Кнопка в картці: додати до порівняння / прибрати. Більше трьох — неактивна. */
export function CompareToggle({ offer }: { offer: Offer }) {
  const t = useTranslations("compare");
  const { offers, toggle } = useCompare();
  const selected = offers.some((o) => compareKey(o) === compareKey(offer));
  const full = !selected && offers.length >= MAX_COMPARE;
  return (
    <Button
      type="button"
      variant={selected ? "secondary" : "outline"}
      size="sm"
      className="w-full"
      aria-pressed={selected}
      disabled={full}
      title={full ? t("full", { max: MAX_COMPARE }) : undefined}
      onClick={() => toggle(offer)}
      data-testid="compare-toggle"
    >
      <Columns3 className="size-3.5" aria-hidden />
      {selected ? t("added") : t("add")}
    </Button>
  );
}

/** Панель унизу: скільки обрано, «Порівняти» відкриває таблицю, «Очистити». */
export function CompareBar({ airlineNames }: { airlineNames: Record<string, string | null> }) {
  const t = useTranslations("compare");
  const { offers, clear } = useCompare();
  const dialog = useRef<HTMLDialogElement>(null);
  if (offers.length === 0) return null;
  return (
    <>
      <div
        className="bg-card/95 fixed inset-x-0 bottom-0 z-40 border-t shadow-lg backdrop-blur"
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
        data-testid="compare-bar"
      >
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
          <span className="font-medium">
            {t("selected", { count: offers.length, max: MAX_COMPARE })}
          </span>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={clear}>
              {t("clear")}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={offers.length < 2}
              onClick={() => dialog.current?.showModal()}
            >
              {t("open")}
            </Button>
          </div>
        </div>
      </div>
      <dialog
        ref={dialog}
        className="bg-card text-card-foreground m-auto w-[min(56rem,calc(100vw-2rem))] rounded-xl border p-0 shadow-2xl backdrop:bg-black/40"
        aria-labelledby="compare-title"
        data-testid="compare-dialog"
      >
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <h2 id="compare-title" className="font-semibold">
            {t("title")}
          </h2>
          <Button type="button" variant="ghost" size="sm" onClick={() => dialog.current?.close()}>
            <X className="size-4" aria-hidden />
            <span className="sr-only">{t("close")}</span>
          </Button>
        </div>
        <div className="overflow-x-auto p-4">
          <CompareTable airlineNames={airlineNames} onEmpty={() => dialog.current?.close()} />
        </div>
      </dialog>
    </>
  );
}

function CompareTable({
  airlineNames,
  onEmpty,
}: {
  airlineNames: Record<string, string | null>;
  onEmpty: () => void;
}) {
  const t = useTranslations("compare");
  const tOffer = useTranslations("offer");
  const format = useFormatter();
  const { offers, remove } = useCompare();
  if (offers.length === 0) return null;
  const cheapest = Math.min(...offers.map((o) => o.price));
  const fastest = Math.min(...offers.map((o) => o.total_duration_min ?? Infinity));
  const dur = (minutes: number | null | undefined) => {
    if (minutes == null) return t("unknown");
    const { hours, minutes: mins } = splitDuration(minutes);
    return tOffer("duration", { hours, minutes: String(mins).padStart(2, "0") });
  };
  const legs = (o: Offer): Leg[] => [o.outbound, ...(o.inbound ? [o.inbound] : [])];
  const times = (o: Offer, pick: (leg: Leg) => string | null | undefined) =>
    legs(o)
      .map((leg) => {
        const at = pick(leg);
        return at
          ? `${localTime(at)} ${pick === arrival ? leg.destination : leg.origin}`
          : t("unknown");
      })
      .join(" / ");
  const departure = (leg: Leg) => leg.departure_at;
  const arrival = (leg: Leg) => leg.arrival_at;

  const rows: [string, (o: Offer) => React.ReactNode][] = [
    [
      t("price"),
      (o) => (
        <span className={cn("font-semibold tabular-nums", o.price === cheapest && "text-success")}>
          {format.number(o.price, {
            style: "currency",
            currency: o.currency,
            maximumFractionDigits: 0,
          })}
        </span>
      ),
    ],
    [
      t("duration"),
      (o) => (
        <span className={cn(o.total_duration_min === fastest && "font-medium text-success")}>
          {dur(o.total_duration_min)}
        </span>
      ),
    ],
    [
      t("stops"),
      (o) =>
        legs(o)
          .map((leg) =>
            leg.stops === 0 ? tOffer("direct") : tOffer("stops", { count: leg.stops }),
          )
          .join(" / "),
    ],
    [
      t("baggage"),
      (o) =>
        o.baggage_included === true
          ? tOffer("baggageIncluded")
          : o.baggage_included === false
            ? tOffer("baggageNotIncluded")
            : tOffer("baggageUnknown"),
    ],
    [t("airline"), (o) => o.airlines.map((c) => airlineNames[c] ?? c).join(", ") || t("unknown")],
    [t("departure"), (o) => times(o, departure)],
    [t("arrival"), (o) => times(o, arrival)],
    [
      t("fare"),
      (o) =>
        [
          o.fare_name,
          o.cabin ? t(`cabin.${o.cabin}`) : null,
          o.seller,
          o.price_status === "live" ? t("live") : t("cached"),
        ]
          .filter(Boolean)
          .join(" · "),
    ],
  ];

  return (
    <table
      className="w-full min-w-[32rem] border-separate border-spacing-0 text-sm"
      data-testid="compare-table"
    >
      <thead>
        <tr>
          <th scope="col" className="w-36" />
          {offers.map((o) => (
            <th key={compareKey(o)} scope="col" className="border-b p-2 text-left align-bottom">
              <div className="flex items-start justify-between gap-2">
                <span className="font-semibold">
                  {o.outbound.origin} → {o.outbound.destination}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    remove(compareKey(o));
                    if (offers.length === 1) onEmpty();
                  }}
                  aria-label={t("remove")}
                >
                  <X className="size-3.5" aria-hidden />
                </Button>
              </div>
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
            {offers.map((o) => (
              <td key={compareKey(o)} className="border-b p-2 align-top">
                {cell(o)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
