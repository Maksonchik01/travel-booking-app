"use client";

import type { CheaperResult, TripQuery } from "@tickets/shared";
import { ArrowRight, BadgePercent, Loader2 } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { DifferenceList } from "@/components/trip-insights";
import { Button } from "@/components/ui/button";
import { localDate, localTime } from "@/lib/format";
import { toTripParams, toYourTrip } from "@/lib/trip-params";
import { useHydrated } from "@/lib/use-hydrated";
import { fetchWithTimeout } from "@/lib/client-fetch";
import { fractionDigits } from "@/lib/money";

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
  // До гідратації клік загубився б — кнопка неактивна, як і на сервері.
  const hydrated = useHydrated();

  async function run() {
    setCheck({ state: "loading" });
    try {
      const response = await fetchWithTimeout("/api/trips/cheaper", {
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
      disabled={!hydrated || check.state === "loading"}
      data-testid="trip-cheaper"
      data-track="cheaper_requested"
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
        <p className="text-muted-foreground text-xs" role={limited ? "status" : "alert"}>
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
      ...fractionDigits(value),
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
      className="grid gap-2 rounded-lg border border-success/40 bg-success/5 p-3 text-sm"
      data-testid="trip-cheaper-result"
      role="status"
    >
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-muted-foreground line-through tabular-nums">
          {money(result.before.money_total)}
        </span>
        <ArrowRight className="size-3.5 self-center" aria-hidden />
        <span className="text-lg font-bold tabular-nums">{money(result.after.money_total)}</span>
        <span className="font-medium text-success">
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
      {/* Конкретні відмінності (етап 4): окрім ціни — пересадки, час у місті, житло. */}
      <DifferenceList
        differences={(result.differences ?? []).filter((d) => d.code !== "cheaper")}
        currency={result.after.currency}
      />
      <p className="text-muted-foreground text-[11px]">{checked}</p>
      <Button asChild size="sm" className="w-fit">
        <Link
          href={toYourTrip(`/trip?${toTripParams(result.apply as TripQuery)}`)}
          data-testid="trip-cheaper-apply"
        >
          {t("apply")}
        </Link>
      </Button>
    </div>
  );
}
