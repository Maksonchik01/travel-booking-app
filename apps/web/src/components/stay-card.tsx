import type { Stay, StayPickLabel, StayScore } from "@tickets/shared";
import {
  AlertTriangle,
  ArrowUpRight,
  BedDouble,
  Building,
  Bus,
  Car,
  ChevronRight,
  Coffee,
  Dog,
  Dumbbell,
  Fence,
  Hotel,
  House,
  MapPin,
  Plane,
  ShieldCheck,
  ShieldOff,
  ShieldQuestion,
  Snowflake,
  Sparkles,
  Star,
  Store,
  Tent,
  UtensilsCrossed,
  Waves,
  Wifi,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { hoursAgo } from "@/lib/format";
import { outboundHref } from "@/lib/outbound";
import { cn } from "@/lib/utils";

const KIND_ICON = {
  hotel: Hotel,
  apartment: Building,
  guesthouse: House,
  hostel: BedDouble,
  other: Tent,
} as const;

const AMENITY_ICON = {
  wifi: Wifi,
  breakfast: Coffee,
  parking: Car,
  pool: Waves,
  gym: Dumbbell,
  kitchen: UtensilsCrossed,
  air_conditioning: Snowflake,
  spa: Sparkles,
  pets: Dog,
  airport_shuttle: Plane,
  balcony: Fence,
} as const;

const KNOWN_SOURCES = new Set(["mock"]);

export function StayCard({
  stay,
  now,
  pickLabel,
  score,
}: {
  stay: Stay;
  now: Date;
  pickLabel?: StayPickLabel;
  score?: StayScore;
}) {
  const t = useTranslations("stayCard");
  const tPicks = useTranslations("stayPicks");
  const tResults = useTranslations("results");
  const format = useFormatter();
  const money = (value: number, digits = 0) =>
    format.number(value, {
      style: "currency",
      currency: stay.currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: digits,
    });
  const KindIcon = KIND_ICON[stay.kind];
  const service = KNOWN_SOURCES.has(stay.source)
    ? tResults(`provider.${stay.source as "mock"}`)
    : stay.source;

  return (
    <Card
      className={cn(
        "lift gap-0 overflow-hidden py-0 sm:grid sm:grid-cols-[9rem_1fr_13rem]",
        "hover:border-primary/40 focus-within:border-primary/50",
        pickLabel && "border-primary/30",
      )}
      data-testid="stay-card"
    >
      {/* Фото від mock немає — тип житла на градієнті. */}
      <div
        aria-hidden
        className="from-primary/15 text-primary/70 hidden place-items-center bg-gradient-to-br to-sky-400/10 sm:grid"
      >
        <KindIcon className="size-10" />
      </div>

      <div className="grid content-start gap-3 p-4 sm:p-5">
        <div className="grid gap-1">
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="text-primary flex items-center gap-1 font-semibold tracking-wide uppercase">
              <KindIcon className="size-3.5 sm:hidden" aria-hidden />
              {t(`kind.${stay.kind}`)}
            </span>
            {stay.stars != null && (
              <span
                className="flex items-center gap-0.5"
                aria-label={t("stars", { count: stay.stars })}
              >
                {Array.from({ length: stay.stars }, (_, i) => (
                  <Star key={i} className="size-3 fill-amber-400 text-amber-400" aria-hidden />
                ))}
              </span>
            )}
            {stay.district && <span>· {stay.district}</span>}
          </div>
          <h3 className="text-lg leading-tight font-semibold" data-testid="stay-name">
            {stay.name}
          </h3>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          <RatingBadge rating={stay.rating ?? null} reviews={stay.review_count ?? 0} />
          <span className="text-muted-foreground flex items-center gap-1">
            <MapPin className="size-3.5" aria-hidden />
            {stay.distance_to_center_km != null
              ? t("toCenter", { km: format.number(stay.distance_to_center_km) })
              : t("centerUnknown")}
          </span>
          <span className="text-muted-foreground flex items-center gap-1">
            <Bus className="size-3.5" aria-hidden />
            {stay.distance_to_transit_m != null
              ? t("toTransit", { m: stay.distance_to_transit_m })
              : t("transitUnknown")}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <CancellationBadge value={stay.cancellation ?? null} />
          <ConditionBadges stay={stay} />
          {(stay.amenities ?? []).slice(0, 6).map((amenity) => {
            const Icon = AMENITY_ICON[amenity];
            return (
              <span
                key={amenity}
                title={t(`amenity.${amenity}`)}
                className="bg-muted text-muted-foreground flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
              >
                <Icon className="size-3" aria-hidden />
                {t(`amenity.${amenity}`)}
              </span>
            );
          })}
        </div>

        {score && (
          <details className="group text-xs" data-testid="stay-score-details">
            <summary className="text-muted-foreground hover:text-primary flex w-fit cursor-pointer list-none items-center gap-1 rounded transition-colors select-none">
              <ChevronRight
                className="size-3.5 transition-transform group-open:rotate-90"
                aria-hidden
              />
              {t("whyScore")}{" "}
              <span className="text-foreground font-medium tabular-nums">
                {money(score.breakdown.total, 2)}
              </span>
            </summary>
            <div className="bg-muted/50 mt-2 max-w-sm rounded-lg p-3">
              <StayScoreDetails score={score} money={(v) => money(v, 2)} />
            </div>
          </details>
        )}
      </div>

      {/* На мобільному ціна — нагорі картки. */}
      <aside className="bg-muted/40 order-first flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b p-4 sm:order-none sm:flex-col sm:flex-nowrap sm:items-stretch sm:justify-start sm:border-b-0 sm:border-l sm:p-5">
        <div>
          {pickLabel && (
            <Badge className="mb-2" data-testid="stay-pick-label">
              {tPicks(`label.${pickLabel}`)}
            </Badge>
          )}
          <p
            className="text-2xl font-bold tracking-tight tabular-nums sm:text-3xl"
            data-testid="stay-price"
          >
            {money(stay.price_per_night)}
          </p>
          <p className="text-muted-foreground text-xs">{t("perNight")}</p>
          <p className="mt-1 text-sm font-medium tabular-nums" data-testid="stay-total">
            {t("total", { nights: stay.nights, total: money(stay.total_price) })}
          </p>
          <p className="text-muted-foreground text-[11px]">{t("withTaxes")}</p>
        </div>
        <div className="grid w-full gap-2 text-xs sm:w-auto">
          <p className="text-muted-foreground">
            {t("foundAgo", { hours: hoursAgo(stay.found_at ?? stay.collected_at, now) })}
          </p>
          <p className="text-muted-foreground flex items-start gap-1.5">
            <Store className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>
              {stay.seller ? `${t("seller", { seller: stay.seller })} · ` : null}
              {t("via", { service })}
            </span>
          </p>
          {stay.deep_link && (
            <Button asChild className="w-full transition-transform active:scale-[0.98]">
              <a
                href={outboundHref(stay.deep_link, "stay", stay.source)}
                target="_blank"
                rel="noopener noreferrer nofollow"
              >
                {t("book")}
                <ArrowUpRight className="size-4" aria-hidden />
              </a>
            </Button>
          )}
          {stay.deep_link && (
            <p className="text-muted-foreground max-w-56 text-[11px] leading-snug">
              {t("partnerNote")}
            </p>
          )}
        </div>
      </aside>
    </Card>
  );
}

export function RatingBadge({ rating, reviews }: { rating: number | null; reviews: number }) {
  const t = useTranslations("stayCard");
  const format = useFormatter();
  if (rating == null) {
    return <span className="text-muted-foreground">{t("noRating")}</span>;
  }
  const word = rating >= 9 ? "excellent" : rating >= 8 ? "veryGood" : rating >= 7 ? "good" : "fair";
  return (
    <span className="flex items-center gap-1.5" data-testid="stay-rating">
      <span
        className={cn(
          "rounded-md px-1.5 py-0.5 text-xs font-bold tabular-nums",
          rating >= 8 ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
        )}
      >
        {format.number(rating, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
      </span>
      <span className="font-medium">{t(`ratingWord.${word}`)}</span>
      <span className="text-muted-foreground">· {t("reviews", { count: reviews })}</span>
    </span>
  );
}

function CancellationBadge({ value }: { value: Stay["cancellation"] }) {
  const t = useTranslations("stayCard");
  if (value === "free") {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
      >
        <ShieldCheck className="size-3" /> {t("cancellation.free")}
      </Badge>
    );
  }
  if (value === "partial" || value === "non_refundable") {
    return (
      <Badge
        variant="outline"
        className="border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400"
      >
        <ShieldOff className="size-3" /> {t(`cancellation.${value}`)}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground">
      <ShieldQuestion className="size-3" /> {t("cancellation.unknown")}
    </Badge>
  );
}

/** Розбивка value-score: ціна за ніч + «ціна» незручностей = оцінка. */
export function StayScoreDetails({
  score,
  money,
}: {
  score: StayScore;
  money: (v: number) => string;
}) {
  const t = useTranslations("stayPicks.breakdown");
  const tWarn = useTranslations("stayPicks.warning");
  const format = useFormatter();
  const b = score.breakdown;
  const plus = (value: number) => (value === 0 ? money(0) : `+${money(value)}`);

  return (
    <div className="grid gap-2">
      <dl
        className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs"
        data-testid="stay-breakdown"
      >
        <dt className="text-muted-foreground">{t("price")}</dt>
        <dd className="text-right tabular-nums">{money(b.price)}</dd>
        <dt className="text-muted-foreground">{t("distance")}</dt>
        <dd className="text-right tabular-nums">{plus(b.distance_penalty)}</dd>
        <dt className="text-muted-foreground">{t("transit")}</dt>
        <dd className="text-right tabular-nums">{plus(b.transit_penalty)}</dd>
        <dt className="text-muted-foreground">
          {t("rating")}
          {b.adjusted_rating != null && (
            <span className="text-[11px]">
              {" "}
              ({t("adjusted", { rating: format.number(b.adjusted_rating) })})
            </span>
          )}
        </dt>
        <dd className="text-right tabular-nums">{plus(b.rating_penalty)}</dd>
        <dt className="text-muted-foreground">{t("cancellation")}</dt>
        <dd className="text-right tabular-nums">{plus(b.cancellation_penalty)}</dd>
        <dt className="border-t pt-1 font-medium">{t("total")}</dt>
        <dd
          className="border-t pt-1 text-right font-medium tabular-nums"
          data-testid="stay-total-score"
        >
          {money(b.total)}
        </dd>
      </dl>
      {score.warnings.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {score.warnings.map((w) => (
            <li key={w.code}>
              <Badge
                variant="outline"
                className="border-amber-500/50 text-amber-700 dark:text-amber-400"
              >
                <AlertTriangle className="size-3" />
                {tWarn(w.code)}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Умови, які джерело ПІДТВЕРДИЛО (модуль 5): сніданок, без передоплати, оплата на місці, ліжка.
 * Невідоме не показуємо як «так» — лише те, що відомо.
 */
function ConditionBadges({ stay }: { stay: Stay }) {
  const t = useTranslations("stayCard");
  const items = [
    stay.breakfast_included === true ? t("condition.breakfast") : null,
    stay.prepayment === "none" ? t("condition.noPrepayment") : null,
    stay.pay_at_property === true ? t("condition.payAtProperty") : null,
    stay.beds != null ? t("condition.beds", { count: stay.beds }) : null,
    (stay.rooms ?? 1) > 1 ? t("condition.rooms", { count: stay.rooms ?? 1 }) : null,
  ].filter((x): x is string => x !== null);
  return (
    <>
      {items.map((text) => (
        <span
          key={text}
          className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-800 dark:text-emerald-300"
          data-testid="stay-condition"
        >
          {text}
        </span>
      ))}
    </>
  );
}
