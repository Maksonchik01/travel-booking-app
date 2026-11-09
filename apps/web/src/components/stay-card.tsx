import type {
  ConvertedPrice,
  PriceFreshness,
  Stay,
  StayPickLabel,
  StayQuery,
  StayReason,
  StayScore,
} from "@tickets/shared";
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
import { ConvertedNote } from "@/components/converted-price";
import { FreshnessBadge } from "@/components/price-freshness";
import { Card } from "@/components/ui/card";
import { WhyList } from "@/components/why-list";
import { StayCardActions } from "@/components/stay-card-actions";
import { favoriteSnapshot } from "@/lib/favorites";
import { hoursAgo } from "@/lib/format";
import { outboundHref } from "@/lib/outbound";
import { tripFromStay } from "@/lib/trip-params";
import { cn } from "@/lib/utils";
import { fractionDigits } from "@/lib/money";

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

/** Фото лише від джерела й лише https; немає — не підставляємо стокових. */
const photoUrl = (stay: Stay) => (stay.image_url?.startsWith("https://") ? stay.image_url : null);

export function StayCard({
  stay,
  now,
  pickLabel,
  score,
  actions,
  query,
  searchParams,
  freshness,
  converted,
}: {
  stay: Stay;
  now: Date;
  /** Сума у валюті пошуку, якщо джерело дало іншу (модуль 18.2). */
  converted?: ConvertedPrice;
  /** Свіжість ціни від API (модуль 17.3). */
  freshness?: PriceFreshness;
  pickLabel?: StayPickLabel;
  score?: StayScore;
  /** Клієнтські дії картки (напр. «На карті») — у колонці ціни. */
  actions?: React.ReactNode;
  /** Запит, що дав об'єкт: з ним — «Порівняти ціни», «В обране», «Додати до поїздки». */
  query?: StayQuery;
  /** Рядок URL пошуку — «Відкрити пошук» з обраного. */
  searchParams?: string;
}) {
  const t = useTranslations("stayCard");
  const tPicks = useTranslations("stayPicks");
  const tResults = useTranslations("results");
  const format = useFormatter();
  const money = (value: number) =>
    format.number(value, {
      style: "currency",
      currency: stay.currency,
      currencyDisplay: "narrowSymbol",
      ...fractionDigits(value),
    });
  const KindIcon = KIND_ICON[stay.kind];
  const service = KNOWN_SOURCES.has(stay.source)
    ? tResults(`provider.${stay.source as "mock"}`)
    : stay.source;
  const photo = photoUrl(stay);

  return (
    <Card
      className={cn(
        "lift gap-0 overflow-hidden py-0 sm:grid sm:grid-cols-[9rem_1fr_13rem]",
        "hover:border-primary/40 focus-within:border-primary/50",
        pickLabel && "border-primary/30",
      )}
      data-testid="stay-card"
    >
      {photo ? (
        // Адреси фото — від джерела, хостів наперед не знаємо (next/image їх не пропустить).
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photo}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="hidden h-full min-h-32 w-full object-cover sm:block"
          data-testid="stay-photo"
        />
      ) : (
        // Фото немає (mock його не дає) — тип житла на градієнті.
        <div
          aria-hidden
          className="from-primary/15 text-primary/70 hidden place-items-center bg-gradient-to-br to-sky-400/10 sm:grid"
        >
          <KindIcon className="size-10" />
        </div>
      )}

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
                role="img"
                aria-label={t("stars", { count: stay.stars })}
              >
                {Array.from({ length: stay.stars }, (_, i) => (
                  <Star key={i} className="size-3 fill-amber-400 text-amber-400" aria-hidden />
                ))}
              </span>
            )}
            {(stay.address ?? stay.district) && <span>· {stay.address ?? stay.district}</span>}
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
                {money(score.breakdown.total)}
              </span>
            </summary>
            <div className="bg-muted/50 mt-2 max-w-sm rounded-lg p-3">
              <StayScoreDetails score={score} money={money} />
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
          <ConvertedNote converted={converted} />
        </div>
        <div className="grid w-full gap-2 text-xs sm:w-auto">
          <FreshnessBadge value={freshness} />
          <p className="text-muted-foreground">
            {t("foundAgo", { hours: hoursAgo(stay.found_at ?? stay.collected_at, now) })}
          </p>
          <p className="text-muted-foreground flex items-start gap-1.5">
            <Store className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>
              {stay.seller ? `${t("seller", { seller: stay.seller })} · ` : null}
              {t("via", { service })}
              {(stay.sellers ?? 0) > 1 && (
                <span className="text-foreground font-medium" data-testid="stay-sellers">
                  {" "}
                  · {t("sellers", { count: stay.sellers ?? 0 })}
                </span>
              )}
            </span>
          </p>
          {actions}
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
      {query && (
        <StayCardActions
          stay={stay}
          query={query}
          favorite={favoriteSnapshot(stay, query, searchParams ?? "")}
          tripHref={tripFromStay(stay, query)}
          now={now.toISOString()}
          details={<StayDetails stay={stay} now={now} />}
        />
      )}
    </Card>
  );
}

/**
 * «Детальніше»: усе, що джерело повідомило про об'єкт; невідоме так і називаємо.
 * Нічого не домальовуємо (адреси, фото, умов, яких немає в даних).
 */
function StayDetails({ stay, now }: { stay: Stay; now: Date }) {
  const t = useTranslations("stayCard");
  const format = useFormatter();
  const unknown = t("unknown");
  const day = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    });
  const yesNo = (value: boolean | null | undefined) =>
    value == null ? unknown : value ? t("yes") : t("no");
  const rows: [string, React.ReactNode][] = [
    [t("detail.address"), stay.address ?? stay.district ?? unknown],
    [
      t("detail.center"),
      stay.distance_to_center_km != null
        ? t("toCenter", { km: format.number(stay.distance_to_center_km) })
        : unknown,
    ],
    [
      t("detail.transit"),
      stay.distance_to_transit_m != null
        ? t("toTransit", { m: stay.distance_to_transit_m })
        : unknown,
    ],
    [
      t("detail.cancellation"),
      stay.cancellation
        ? `${t(`cancellation.${stay.cancellation}`)}${
            stay.free_cancellation_until
              ? ` · ${t("detail.until", { date: day(stay.free_cancellation_until) })}`
              : ""
          }`
        : unknown,
    ],
    [
      t("detail.prepayment"),
      stay.prepayment == null
        ? unknown
        : stay.prepayment === "none"
          ? t("detail.noPrepayment")
          : t("detail.prepaymentRequired"),
    ],
    [t("detail.payAtProperty"), yesNo(stay.pay_at_property)],
    [t("detail.breakfast"), yesNo(stay.breakfast_included)],
    [t("detail.beds"), stay.beds != null ? String(stay.beds) : unknown],
    [
      t("detail.amenities"),
      stay.amenities?.length ? stay.amenities.map((a) => t(`amenity.${a}`)).join(", ") : unknown,
    ],
    [
      t("detail.updated"),
      t("foundAgo", { hours: hoursAgo(stay.found_at ?? stay.collected_at, now) }),
    ],
  ];
  return (
    <dl className="grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-[10rem_1fr]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
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
      <Badge variant="outline" className="border-success/40 bg-success/5 text-success">
        <ShieldCheck className="size-3" /> {t("cancellation.free")}
      </Badge>
    );
  }
  if (value === "partial" || value === "non_refundable") {
    return (
      <Badge variant="outline" className="border-warning/40 bg-warning/5 text-warning">
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

/**
 * «Чому цей варіант?» житла (модуль 14.5): порівняння з найдешевшим і найкраще оціненим —
 * гроші за все проживання, кілометри, бали рейтингу. Числа рахує API.
 */
function StayWhyReasons({
  reasons,
  money,
}: {
  reasons: StayReason[];
  money: (v: number) => string;
}) {
  const t = useTranslations("stayPicks.reason");
  const format = useFormatter();
  const num = (v: number | null | undefined) => format.number(v ?? 0, { maximumFractionDigits: 1 });
  const text = (r: StayReason) => {
    const amount = money(r.amount ?? 0);
    switch (r.code) {
      case "pricier_but_closer":
        return r.amount
          ? t("pricier_but_closer", { amount, km: num(r.km) })
          : t("same_price_closer", { km: num(r.km) });
      case "pricier_but_better_rated":
        return r.amount
          ? t("pricier_but_better_rated", { amount, rating: num(r.rating) })
          : t("same_price_better_rated", { rating: num(r.rating) });
      case "cheaper_than_top_rated":
        return r.rating != null
          ? t("cheaper_than_top_rated_rating", { amount, rating: num(r.rating) })
          : t("cheaper_than_top_rated", { amount });
      case "best_balance":
        return t("best_balance", { total: amount });
      case "within_budget":
        return t("within_budget", { amount });
      case "cheapest":
      case "top_rated":
        return t(r.code, { count: r.count ?? 0 });
      default:
        return t(r.code);
    }
  };
  return <WhyList items={reasons.map(text)} testId="stay-why-reasons" />;
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
  const tCard = useTranslations("stayCard");
  const format = useFormatter();
  const b = score.breakdown;
  const plus = (value: number) => (value === 0 ? money(0) : `+${money(value)}`);
  const missing = b.missing_amenities ?? [];

  return (
    <div className="grid gap-3">
      <StayWhyReasons reasons={score.reasons ?? []} money={money} />
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
        {missing.length > 0 && (
          <>
            <dt className="text-muted-foreground">
              {t("amenities", {
                list: format.list(missing.map((a) => tCard(`amenity.${a}`))),
              })}
            </dt>
            <dd className="text-right tabular-nums">{plus(b.amenity_penalty ?? 0)}</dd>
          </>
        )}
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
              <Badge variant="outline" className="border-warning/50 text-warning">
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
          className="flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] text-success"
          data-testid="stay-condition"
        >
          {text}
        </span>
      ))}
    </>
  );
}
