import type { ExploreDestination, ExploreQuery } from "@tickets/shared";
import { ArrowRight, BedDouble, ImageOff, Luggage, Plane, Star } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import { ExploreCompareToggle, type ExploreCompareItem } from "@/components/explore-compare";
import { FavoriteToggle } from "@/components/favorites";
import { destinationFavorite } from "@/lib/favorites";
import { FreshnessBadge } from "@/components/price-freshness";
import { Button } from "@/components/ui/button";
import { flightsHref, toExploreParams, tripHref } from "@/lib/explore-params";
import { fractionDigits } from "@/lib/money";
import { cn } from "@/lib/utils";

/** Напрямок Explore (ADR 0045): фото, місто й країна, дати й ночі, ціна; житло — у режимі trip. */
export function ExploreCard({
  destination,
  query,
  countryName,
}: {
  destination: ExploreDestination;
  query: ExploreQuery;
  countryName: string;
}) {
  const t = useTranslations("explore.card");
  const tCat = useTranslations("explore.category");
  const format = useFormatter();
  const d = destination;
  const offer = d.offer;
  const currency = offer.currency;
  const money = (value: number) =>
    format.number(value, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      ...fractionDigits(value),
    });
  const date = (iso: string) =>
    format.dateTime(new Date(`${iso.slice(0, 10)}T00:00:00Z`), {
      day: "numeric",
      month: "short",
      weekday: "short",
      timeZone: "UTC",
    });
  const depart = offer.outbound.departure_at.slice(0, 10);
  const back = offer.inbound?.departure_at.slice(0, 10) ?? depart;
  const stops = Math.max(offer.outbound.stops, offer.inbound?.stops ?? 0);
  const adults = query.adults ?? 1;
  const trip = query.mode === "trip";
  const flights = flightsHref(d, query);
  const params = toExploreParams(query).toString();
  const tripLink = tripHref(d, query);
  const minutes =
    offer.outbound.duration_min != null && offer.inbound?.duration_min != null
      ? offer.outbound.duration_min + offer.inbound.duration_min
      : null;
  const compare: ExploreCompareItem = {
    key: `${d.code}:${depart}:${back}`,
    city: d.city_name,
    country: countryName,
    depart,
    back,
    nights: d.nights,
    currency,
    flight: offer.price,
    stay: d.stay?.total_price ?? null,
    stayName: d.stay?.name ?? null,
    total: d.total ?? null,
    flightMinutes: minutes,
    stops,
    flightsHref: flights,
    tripHref: tripLink,
  };

  return (
    <article
      className="bg-card lift group grid overflow-hidden rounded-xl border shadow-sm"
      data-testid="explore-card"
      data-code={d.code}
      id={`dest-${d.code}`}
    >
      <div className="bg-muted relative aspect-[16/10] overflow-hidden">
        {d.photo ? (
          <>
            {/* Фото — з upload.wikimedia.org (довідник напрямків), без Referer. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={d.photo.url}
              alt={t("photoAlt", { city: d.city_name })}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              className="absolute inset-0 size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
            />
            <a
              href={d.photo.page}
              target="_blank"
              rel="noopener noreferrer"
              className="absolute right-1.5 bottom-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white hover:bg-black/75"
            >
              {t("photoCredit")}
            </a>
          </>
        ) : (
          <div className="from-primary/25 grid size-full place-items-center bg-gradient-to-br to-sky-400/25">
            <ImageOff className="text-muted-foreground size-6" aria-hidden />
          </div>
        )}
        {d.categories.length > 0 && (
          <div className="absolute top-2 left-2 flex flex-wrap gap-1">
            {d.categories.slice(0, 2).map((c) => (
              <span
                key={c}
                className="rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm"
              >
                {tCat(c)}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-lg leading-tight font-semibold">{d.city_name}</h3>
            <p className="text-muted-foreground truncate text-xs">{countryName}</p>
          </div>
          <div className="text-right">
            <p
              className="text-xl font-bold tracking-tight tabular-nums"
              data-testid="explore-price"
            >
              {money(trip && d.total != null ? d.total : offer.price)}
            </p>
            <p className="text-muted-foreground text-[11px]">
              {trip && d.total != null
                ? t("totalFor", { count: adults })
                : t("flightFor", { count: adults })}
            </p>
          </div>
        </div>

        <p className="text-sm">
          {date(depart)} – {date(back)}
          <span className="text-muted-foreground">
            {" · "}
            {d.nights_approximate
              ? t("nightsApprox", { count: d.nights })
              : t("nights", { count: d.nights })}
          </span>
        </p>

        <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="flex items-center gap-1">
            <Plane className="size-3.5" aria-hidden />
            {offer.outbound.origin} → {offer.outbound.destination}
          </span>
          <span className={cn(stops === 0 && "text-success font-medium")}>
            {stops === 0 ? t("direct") : t("stops", { count: stops })}
          </span>
          <FreshnessBadge value={d.freshness} />
        </div>

        {trip && <StayLine destination={d} money={money} />}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button asChild size="sm" variant={trip ? "outline" : "default"}>
            <Link href={flights} data-testid="explore-to-flights">
              <Plane className="size-3.5" aria-hidden />
              {t("toFlights")}
            </Link>
          </Button>
          <Button asChild size="sm" variant={trip ? "default" : "outline"}>
            <Link href={tripLink} data-testid="explore-to-trip">
              <Luggage className="size-3.5" aria-hidden />
              {t("toTrip")}
              <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          </Button>
          <ExploreCompareToggle item={compare} />
          <FavoriteToggle body={destinationFavorite(d, query, params)} compact />
        </div>
      </div>
    </article>
  );
}

function StayLine({
  destination,
  money,
}: {
  destination: ExploreDestination;
  money: (value: number) => string;
}) {
  const t = useTranslations("explore.card");
  const format = useFormatter();
  const stay = destination.stay;
  if (destination.stay_status === "ok" && stay) {
    return (
      <div
        className="bg-muted/50 grid gap-0.5 rounded-lg px-3 py-2 text-xs"
        data-testid="explore-stay"
      >
        <p className="flex items-center gap-1.5 font-medium">
          <BedDouble className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{stay.name}</span>
          {stay.rating != null && (
            <span className="text-muted-foreground flex shrink-0 items-center gap-0.5">
              <Star className="size-3 fill-amber-400 text-amber-400" aria-hidden />
              {format.number(stay.rating, { maximumFractionDigits: 1 })}
            </span>
          )}
        </p>
        <p className="text-muted-foreground">
          {t("breakdown", {
            flight: money(destination.offer.price),
            stay: money(stay.total_price),
          })}
          {stay.taxes_included !== true && ` · ${t("taxesUnknown")}`}
        </p>
      </div>
    );
  }
  return (
    <p
      className="text-muted-foreground flex items-center gap-1.5 text-xs"
      data-testid="explore-stay"
    >
      <BedDouble className="size-3.5 shrink-0" aria-hidden />
      {t(`stayStatus.${destination.stay_status ?? "not_checked"}`)}
    </p>
  );
}
