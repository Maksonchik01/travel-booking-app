"use client";

import type { BaggageNeed, Cabin, Passengers } from "@tickets/shared";
import { ChevronDown, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { BAGGAGE_NEEDS, CABINS, CURRENCIES, MAX_PASSENGERS } from "@/lib/search-params";
import { FIELD_CLASS, SELECT_CLASS } from "@/lib/styles";
import { cn } from "@/lib/utils";

type Counts = { adults: number; children: number; lap: number; seat: number };

/** Межі кожного лічильника за правилами Passengers (API): до 9, на руках ≤ дорослих, ≤ 2 немовлят на дорослого. */
export function passengerLimits(c: Counts): Counts {
  const others = (keep: keyof Counts) =>
    MAX_PASSENGERS -
    (Object.keys(c) as (keyof Counts)[]).reduce((s, k) => (k === keep ? s : s + c[k]), 0);
  return {
    adults: Math.min(MAX_PASSENGERS, others("adults")),
    children: others("children"),
    lap: Math.min(c.adults, others("lap"), 2 * c.adults - c.seat),
    seat: Math.min(others("seat"), 2 * c.adults - c.lap),
  };
}

/**
 * Склад пасажирів і клас: розкривний блок (`<details>` працює й без JS), у формі — поля
 * adults, children, lap, seat, cabin. Ціну за весь склад рахує джерело (ADR 0013).
 */
export function PassengerPicker({
  passengers,
  cabin,
  baggage,
  currency,
}: {
  passengers?: Passengers;
  cabin?: Cabin;
  baggage?: BaggageNeed;
  currency?: string;
}) {
  const t = useTranslations("search");
  const [counts, setCounts] = useState<Counts>({
    adults: passengers?.adults ?? 1,
    children: passengers?.children ?? 0,
    lap: passengers?.infants ?? 0,
    seat: passengers?.infants_in_seat ?? 0,
  });
  const [cabinValue, setCabinValue] = useState<Cabin>(cabin ?? "economy");
  const [bag, setBag] = useState<BaggageNeed>(baggage ?? "none");
  const [cur, setCur] = useState(currency ?? "EUR");
  const limits = passengerLimits(counts);

  function set(key: keyof Counts, value: number) {
    setCounts((prev) => {
      const next = { ...prev, [key]: value };
      // Менше дорослих — менше дозволених немовлят: зайве відкидаємо, а не лишаємо невалідним.
      next.lap = Math.min(next.lap, next.adults);
      next.seat = Math.min(next.seat, 2 * next.adults - next.lap);
      return next;
    });
  }

  const rows: { key: keyof Counts; name: string; min: number }[] = [
    { key: "adults", name: "adults", min: 1 },
    { key: "children", name: "children", min: 0 },
    { key: "lap", name: "lap", min: 0 },
    { key: "seat", name: "seat", min: 0 },
  ];
  const total = counts.adults + counts.children + counts.lap + counts.seat;

  return (
    <details className="group relative">
      <summary
        className={cn(
          FIELD_CLASS,
          "border-input flex cursor-pointer list-none items-center gap-2 border px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden",
        )}
      >
        <Users className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <span className="truncate">
          {t("passengersSummary", { count: total })} · {t(`cabins.${cabinValue}`)}
          {bag !== "none" && ` · ${t(`bagsShort.${bag}`)}`}
          {cur !== "EUR" && ` · ${cur}`}
        </span>
        <ChevronDown
          className="text-muted-foreground ml-auto size-4 shrink-0 transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>
      <div className="bg-popover text-popover-foreground absolute right-0 z-30 mt-2 grid w-72 gap-3 rounded-xl border p-4 shadow-lg">
        {rows.map(({ key, name, min }) => (
          <label key={key} className="flex items-center justify-between gap-3 text-sm">
            <span>
              {t(`pax.${key}`)}
              <span className="text-muted-foreground block text-xs">{t(`paxHint.${key}`)}</span>
            </span>
            <select
              name={name}
              value={counts[key]}
              onChange={(e) => set(key, Number(e.target.value))}
              className={cn(SELECT_CLASS, "w-20")}
            >
              {Array.from(
                { length: Math.max(limits[key], counts[key]) - min + 1 },
                (_, i) => i + min,
              ).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label className="flex items-center justify-between gap-3 border-t pt-3 text-sm">
          <span>{t("cabin")}</span>
          <select
            name="cabin"
            value={cabinValue}
            onChange={(e) => setCabinValue(e.target.value as Cabin)}
            className={cn(SELECT_CLASS, "w-40")}
          >
            {CABINS.map((c) => (
              <option key={c} value={c}>
                {t(`cabins.${c}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>
            {t("baggage")}
            <span className="text-muted-foreground block text-xs">{t("baggageHint")}</span>
          </span>
          <select
            name="bag"
            value={bag}
            onChange={(e) => setBag(e.target.value as BaggageNeed)}
            className={cn(SELECT_CLASS, "w-40")}
          >
            {BAGGAGE_NEEDS.map((b) => (
              <option key={b} value={b}>
                {t(`bags.${b}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>{t("currency")}</span>
          <select
            name="cur"
            value={cur}
            onChange={(e) => setCur(e.target.value)}
            className={cn(SELECT_CLASS, "w-40")}
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <p className="text-muted-foreground text-xs">{t("paxRules")}</p>
      </div>
    </details>
  );
}
