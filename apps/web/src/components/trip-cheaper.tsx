"use client";

import type { CheaperResult, TripQuery } from "@tickets/shared";
import { ArrowRight, BadgePercent, Loader2 } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { localDate, localTime } from "@/lib/format";
import { toTripParams } from "@/lib/trip-params";

type State =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "failed"; reason: "error" | "rate_limited" }
  | { state: "done"; result: CheaperResult };

/**
 * «Знайти дешевший варіант» (8.4): ще один пошук — лише на натискання. Показуємо було / стало,
 * різницю, що змінилося, і скільки перевірено; нічого не знайшли — так і кажемо.
 */
export function TripCheaper({ query }: { query: TripQuery }) {
  const t = useTranslations("tripBuilder");
  const format = useFormatter();
  const [check, setCheck] = useState<State>({ state: "idle" });

  async function run() {
    setCheck({ state: "loading" });
    try {
      const response = await fetch("/api/trips/cheaper", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(query),
      });
      if (!response.ok) {
        setCheck({ state: "failed", reason: response.status === 429 ? "rate_limited" : "error" });
        return;
      }
      setCheck({ state: "done", result: (await response.json()) as CheaperResult });
    } catch {
      setCheck({ state: "failed", reason: "error" });
    }
  }

  const button = (
    <Button
      type="button"
      size="sm"
      onClick={run}
      disabled={check.state === "loading"}
      data-testid="trip-cheaper"
    >
      {check.state === "loading" ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
      ) : (
        <BadgePercent className="size-3.5" aria-hidden />
      )}
      {check.state === "loading" ? t("cheaperSearching") : t("cheaper")}
    </Button>
  );
  if (check.state === "idle" || check.state === "loading") return button;
  if (check.state === "failed" || check.result.status === "no_trip") {
    const limited = check.state === "failed" && check.reason === "rate_limited";
    return (
      <div className="grid gap-2">
        {button}
        <p className="text-muted-foreground text-xs" role="status">
          {t(limited ? "rateLimited" : "cheaperFailed")}
        </p>
      </div>
    );
  }
  const result = check.result;
  const money = (value: number) =>
    format.number(value, {
      style: "currency",
      currency: result.before?.currency ?? "EUR",
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: 0,
    });
  const checked = t("checked", {
    flights: result.flights_checked ?? 0,
    combos: result.combos_checked ?? 0,
  });
  if (result.status === "not_found" || !result.after || !result.before || !result.apply) {
    return (
      <div className="grid gap-1.5" data-testid="trip-cheaper-result">
        <p className="text-sm" role="status">
          {t("notFound")}
        </p>
        <p className="text-muted-foreground text-xs">{checked}</p>
      </div>
    );
  }
  const offer = result.offers?.[1];
  const stay = result.stays?.[1];
  const day = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  return (
    <div
      className="grid gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm"
      data-testid="trip-cheaper-result"
      role="status"
    >
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-muted-foreground line-through tabular-nums">
          {money(result.before.money_total)}
        </span>
        <ArrowRight className="size-3.5 self-center" aria-hidden />
        <span className="text-lg font-bold tabular-nums">{money(result.after.money_total)}</span>
        <span className="font-medium text-emerald-700 dark:text-emerald-400">
          {t("saving", { amount: money(result.saving ?? 0) })}
        </span>
      </p>
      <ul className="text-muted-foreground grid gap-0.5 text-xs">
        {(result.changes ?? []).map((change) => (
          <li key={change}>
            {change === "dates"
              ? t("change.dates", {
                  from: day(result.after!.window.check_in),
                  to: day(result.after!.window.check_out),
                })
              : change === "flight" && offer
                ? t("change.flight", {
                    out: `${day(localDate(offer.outbound.departure_at))} ${localTime(offer.outbound.departure_at)}`,
                    route: `${offer.outbound.origin} → ${offer.outbound.destination}`,
                  })
                : change === "stay" && stay
                  ? t("change.stay", { name: stay.name })
                  : t(`change.${change}`)}
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground text-[11px]">{checked}</p>
      <Button asChild size="sm" className="w-fit">
        <Link
          href={`/trip?${toTripParams(result.apply as TripQuery)}`}
          data-testid="trip-cheaper-apply"
        >
          {t("apply")}
        </Link>
      </Button>
    </div>
  );
}
