import type { Leg, Offer, Stay, TripCombo, TripPickLabel } from "@tickets/shared";
import { AlertTriangle, ArrowRight, BedDouble, Crown, Plane, Scale, Wallet } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import { AirlineLogo, legCarriers } from "@/components/airline-logo";
import { offerAnchor } from "@/components/top-picks";
import { RatingBadge } from "@/components/stay-card";
import { stayAnchor } from "@/components/stay-picks";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { localDate, localTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const LABEL_ICON = { cheapest: Wallet, best_value: Scale, comfort: Crown } as const;

type Props = {
  combo: TripCombo;
  offer: Offer;
  stay: Stay;
  adults: number;
  label?: TripPickLabel;
  also?: TripPickLabel[];
  airlineNames: Record<string, string | null>;
  /** Сторінки перельотів і житла з тими самими параметрами (для деталей). */
  flightsHref: string;
  staysHref: string;
};

/** Одна поїздка: загальна сума з розбивкою, рейс і житло — і посилання на їхні сторінки. */
export function TripCard({
  combo,
  offer,
  stay,
  adults,
  label,
  also = [],
  airlineNames,
  flightsHref,
  staysHref,
}: Props) {
  const t = useTranslations("tripCard");
  const tPicks = useTranslations("tripPicks");
  const format = useFormatter();
  const money = (value: number, digits = 0) =>
    format.number(value, {
      style: "currency",
      currency: combo.currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: digits,
    });
  const Icon = label ? LABEL_ICON[label] : null;
  const recommended = label === "best_value";

  return (
    <Card
      className={cn(
        "lift h-full gap-4 p-4 sm:p-5",
        recommended
          ? "border-primary/50 from-primary/[0.07] to-card bg-gradient-to-b"
          : "hover:border-primary/30",
      )}
      data-testid="trip-card"
      data-label={label}
    >
      {label && Icon && (
        <div className="grid gap-0.5">
          <p className="flex items-center gap-2 font-semibold">
            <span
              className={cn(
                "grid size-7 place-items-center rounded-lg",
                recommended ? "bg-primary text-primary-foreground" : "bg-accent text-primary",
              )}
            >
              <Icon className="size-4" aria-hidden />
            </span>
            {tPicks(`label.${label}`)}
          </p>
          {also.length > 0 && (
            <p className="text-muted-foreground text-xs">
              {tPicks("also", { labels: format.list(also.map((l) => tPicks(`alsoLabel.${l}`))) })}
            </p>
          )}
        </div>
      )}

      <div>
        <p className="text-3xl font-bold tracking-tight tabular-nums" data-testid="trip-total">
          {money(combo.money_total)}
        </p>
        <p className="text-muted-foreground text-xs">
          {t("forTrip", { adults, nights: combo.window.nights })}
        </p>
      </div>

      <dl
        className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm"
        data-testid="trip-breakdown"
      >
        <dt className="text-muted-foreground flex items-center gap-1.5">
          <Plane className="size-3.5" aria-hidden />
          {adults > 1
            ? t("flightTimes", { adults, price: money(combo.flight_price) })
            : t("flight")}
        </dt>
        <dd className="text-right tabular-nums">{money(combo.flight_total)}</dd>
        <dt className="text-muted-foreground flex items-center gap-1.5">
          <BedDouble className="size-3.5" aria-hidden />
          {t("stay", { nights: combo.window.nights })}
        </dt>
        <dd className="text-right tabular-nums">{money(combo.stay_total)}</dd>
        <dt className="border-t pt-1 font-medium">{t("total")}</dt>
        <dd className="border-t pt-1 text-right font-medium tabular-nums">
          {money(combo.money_total)}
        </dd>
      </dl>

      <div className="grid gap-2 border-t pt-3 text-xs">
        <LegLine leg={offer.outbound} offer={offer} names={airlineNames} label={t("outbound")} />
        {offer.inbound && (
          <LegLine leg={offer.inbound} offer={offer} names={airlineNames} label={t("inbound")} />
        )}
      </div>

      <div className="grid gap-1.5 border-t pt-3 text-xs">
        <p className="text-sm font-semibold">{stay.name}</p>
        <RatingBadge rating={stay.rating ?? null} reviews={stay.review_count ?? 0} />
        <p className="text-muted-foreground">
          {t("stayDates", {
            from: shortDate(format, combo.window.check_in),
            to: shortDate(format, combo.window.check_out),
          })}
          {stay.distance_to_center_km != null &&
            ` · ${t("toCenter", { km: format.number(stay.distance_to_center_km) })}`}
        </p>
      </div>

      {(combo.warnings ?? []).length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {(combo.warnings ?? []).map((w) => (
            <li key={w}>
              <Badge
                variant="outline"
                className="border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400"
              >
                <AlertTriangle className="size-3" /> {t(`warning.${w}`)}
              </Badge>
            </li>
          ))}
        </ul>
      )}

      {combo.value_total != null && (
        <p className="text-muted-foreground text-[11px]">
          {t("value", { value: money(combo.value_total) })}
        </p>
      )}

      <div className="mt-auto flex flex-wrap gap-2">
        <TripLink href={`${flightsHref}#${offerAnchor(combo.offer_key)}`} icon={Plane}>
          {t("openFlight")}
        </TripLink>
        <TripLink href={`${staysHref}#${stayAnchor(combo.stay_key)}`} icon={BedDouble}>
          {t("openStay")}
        </TripLink>
      </div>
    </Card>
  );
}

function TripLink({
  href,
  icon: Icon,
  children,
}: {
  href: string;
  icon: typeof Plane;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="bg-accent text-accent-foreground hover:bg-primary hover:text-primary-foreground flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors"
    >
      <Icon className="size-3.5" aria-hidden />
      {children}
      <ArrowRight className="size-3" aria-hidden />
    </Link>
  );
}

function LegLine({
  leg,
  offer,
  names,
  label,
}: {
  leg: Leg;
  offer: Offer;
  names: Record<string, string | null>;
  label: string;
}) {
  const t = useTranslations("offer");
  const format = useFormatter();
  const carriers = legCarriers(leg, offer);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <span className="flex items-center gap-1.5">
        <span className="text-primary font-semibold uppercase">{label}</span>
        <span className="text-muted-foreground">
          {shortDate(format, localDate(leg.departure_at))}
        </span>
        <span className="font-medium tabular-nums">
          {localTime(leg.departure_at)}
          {leg.arrival_at ? ` → ${localTime(leg.arrival_at)}` : ""}
        </span>
        <span className="text-muted-foreground">
          · {leg.stops === 0 ? t("direct") : t("stops", { count: leg.stops })}
        </span>
      </span>
      {carriers.length > 0 && (
        <span className="flex items-center gap-1">
          {carriers.map((code) => (
            <AirlineLogo key={code} code={code} url={offer.airline_logos?.[code]} size={16} />
          ))}
          <span className="text-muted-foreground max-w-32 truncate">
            {carriers.map((c) => names[c] ?? c).join(" · ")}
          </span>
        </span>
      )}
    </div>
  );
}

function shortDate(format: ReturnType<typeof useFormatter>, iso: string): string {
  return format.dateTime(new Date(`${iso}T00:00:00Z`), {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}
