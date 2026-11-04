import type { Leg, Offer, OfferScore, PickLabel } from "@tickets/shared";
import { AlertTriangle, ArrowUpRight, Briefcase, Clock, Moon, Ticket } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScoreDetails } from "@/components/top-picks";
import { Separator } from "@/components/ui/separator";
import { dayShift, daysAgo, hoursAgo, localTime, splitDuration } from "@/lib/format";
import { layoverRisks, type LayoverRisk } from "@/lib/risks";

const RISK_ICON: Record<LayoverRisk, typeof Clock> = {
  short: AlertTriangle,
  long: Clock,
  overnight: Moon,
  selfTransfer: Ticket,
};

export function OfferCard({
  offer,
  now,
  pickLabel,
  score,
  airlineNames,
}: {
  offer: Offer;
  now: Date;
  pickLabel?: PickLabel;
  score?: OfferScore;
  /** IATA-код → назва (з фасетів пошуку); невідомі показуємо кодом. */
  airlineNames?: Record<string, string | null>;
}) {
  const t = useTranslations("offer");
  const tPicks = useTranslations("picks");
  const format = useFormatter();
  const money = (value: number) =>
    format.number(value, {
      style: "currency",
      currency: offer.currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: value % 1 === 0 ? 0 : 2,
    });

  // Точність віку ціни — така, яку дає джерело: години, лише день або невідомо.
  const age = offer.found_at
    ? t("foundAgo", { hours: hoursAgo(offer.found_at, now) })
    : offer.found_on
      ? t("foundOnAgo", { days: daysAgo(offer.found_on, now) })
      : t("collectedAgo", { hours: hoursAgo(offer.collected_at, now) });

  return (
    <Card className="gap-0 overflow-hidden py-0" data-testid="offer-card">
      <CardContent className="grid gap-0 p-0 sm:grid-cols-[1fr_12rem]">
        <div className="grid content-center gap-4 p-5">
          <LegRow label={t("outbound")} leg={offer.outbound} />
          {offer.inbound && (
            <>
              <Separator />
              <LegRow label={t("inbound")} leg={offer.inbound} />
            </>
          )}
          {score && (
            <details className="group text-xs" data-testid="score-details">
              <summary className="text-muted-foreground hover:text-foreground w-fit cursor-pointer select-none">
                {t("whyScore")}{" "}
                <span className="text-foreground font-medium tabular-nums">
                  {score.breakdown.total != null
                    ? money(score.breakdown.total)
                    : tPicks("breakdown.unknown")}
                </span>
              </summary>
              <div className="mt-2 max-w-sm">
                <ScoreDetails score={score} money={money} />
              </div>
            </details>
          )}
        </div>

        <aside className="bg-muted/40 flex flex-col justify-between gap-4 border-t p-5 sm:border-t-0 sm:border-l">
          <div>
            {pickLabel && (
              <Badge className="mb-2" data-testid="pick-label">
                {tPicks(`label.${pickLabel}`)}
              </Badge>
            )}
            <p className="text-2xl font-semibold tracking-tight tabular-nums" data-testid="price">
              {format.number(offer.price, {
                style: "currency",
                currencyDisplay: "narrowSymbol",
                currency: offer.currency,
                maximumFractionDigits: 0,
              })}
            </p>
            <p className="text-muted-foreground text-xs">{t("perAdult")}</p>
            <p className="text-muted-foreground mt-2 text-xs" data-testid="price-age">
              {age}
            </p>
          </div>

          <div className="grid gap-2 text-xs">
            <BaggageNote included={offer.baggage_included ?? null} />
            {offer.airlines.length > 0 && (
              <p className="text-muted-foreground" data-testid="airlines">
                {offer.airlines.map((code) => airlineNames?.[code] ?? code).join(" · ")}
              </p>
            )}
            {offer.seller && (
              <p className="text-muted-foreground" data-testid="seller">
                {t("seller", { seller: offer.seller })}
              </p>
            )}
            {offer.deep_link ? (
              <Button asChild size="sm" className="w-full">
                <a href={offer.deep_link} target="_blank" rel="noopener noreferrer nofollow">
                  {isGoogleFlights(offer.deep_link) ? t("openGoogleFlights") : t("book")}{" "}
                  <ArrowUpRight className="size-3.5" />
                </a>
              </Button>
            ) : (
              <p className="text-muted-foreground">{t("source", { source: offer.source })}</p>
            )}
          </div>
        </aside>
      </CardContent>
    </Card>
  );
}

function isGoogleFlights(url: string): boolean {
  return url.startsWith("https://www.google.com/travel/flights");
}

function LegRow({ label, leg }: { label: string; leg: Leg }) {
  const t = useTranslations("offer");
  const shift = leg.arrival_at ? dayShift(leg.departure_at, leg.arrival_at) : 0;

  return (
    <div className="grid gap-2">
      <div className="text-muted-foreground flex items-center justify-between text-xs">
        <span className="font-medium tracking-wide uppercase">{label}</span>
        <span>
          {leg.duration_min != null ? duration(t, leg.duration_min) : t("durationUnknown")}
        </span>
      </div>

      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3">
        <Endpoint time={localTime(leg.departure_at)} airport={leg.origin} />
        <div className="relative flex flex-col items-center">
          <div className="bg-border absolute top-1/2 h-px w-full" aria-hidden />
          <div className="relative flex gap-1.5" aria-hidden>
            {Array.from({ length: leg.stops }, (_, i) => (
              <span
                key={i}
                className="bg-background border-foreground/50 size-2 rounded-full border"
              />
            ))}
          </div>
          <span className="text-muted-foreground bg-background relative mt-1 px-2 text-xs">
            {leg.stops === 0 ? t("direct") : t("stops", { count: leg.stops })}
          </span>
        </div>
        {/* Час прильоту не вигадуємо: без поясу аеропорту прильоту його не порахувати. */}
        <Endpoint
          time={leg.arrival_at ? localTime(leg.arrival_at) : null}
          airport={leg.destination}
          shift={shift}
          align="end"
        />
      </div>

      <Layovers leg={leg} />
    </div>
  );
}

function Endpoint({
  time,
  airport,
  shift = 0,
  align = "start",
}: {
  time: string | null;
  airport: string;
  shift?: number;
  align?: "start" | "end";
}) {
  return (
    <div className={align === "end" ? "text-right" : undefined}>
      {time ? (
        <>
          <p className="text-lg font-semibold tabular-nums">
            {time}
            {shift > 0 && <sup className="text-muted-foreground ml-0.5 text-xs">+{shift}</sup>}
          </p>
          <p className="text-muted-foreground text-xs font-medium">{airport}</p>
        </>
      ) : (
        <p className="text-lg font-semibold">{airport}</p>
      )}
    </div>
  );
}

function Layovers({ leg }: { leg: Leg }) {
  const t = useTranslations("offer");
  if (leg.stops === 0) return null;

  if (leg.layovers == null) {
    return (
      <Badge
        variant="outline"
        className="w-fit border-amber-500/50 text-amber-700 dark:text-amber-400"
      >
        <AlertTriangle className="size-3" /> {t("detailsUnknown")}
      </Badge>
    );
  }

  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
      {leg.layovers.map((layover, i) => {
        const risks = layoverRisks(layover);
        return (
          <li key={i} className="flex flex-wrap items-center gap-1.5" data-testid="layover">
            <span className="text-muted-foreground">
              {t("layoverIn", {
                airport: layover.airport,
                duration: duration(t, layover.duration_min),
              })}
            </span>
            {risks.map((risk) => {
              const Icon = RISK_ICON[risk];
              return (
                <Badge
                  key={risk}
                  variant="outline"
                  className="border-amber-500/50 text-amber-700 dark:text-amber-400"
                >
                  <Icon className="size-3" /> {t(`risk.${risk}`)}
                </Badge>
              );
            })}
          </li>
        );
      })}
    </ul>
  );
}

function BaggageNote({ included }: { included: boolean | null }) {
  const t = useTranslations("offer");
  const text =
    included === true
      ? t("baggageIncluded")
      : included === false
        ? t("baggageNotIncluded")
        : t("baggageUnknown");
  return (
    <p className="text-muted-foreground flex items-center gap-1.5">
      <Briefcase className="size-3.5" aria-hidden /> {text}
    </p>
  );
}

function duration(t: ReturnType<typeof useTranslations<"offer">>, minutes: number) {
  const { hours, minutes: mins } = splitDuration(minutes);
  if (hours === 0) return t("durationShort", { minutes: mins });
  return t("duration", { hours, minutes: String(mins).padStart(2, "0") });
}
