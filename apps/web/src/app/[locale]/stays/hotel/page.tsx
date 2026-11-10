import type { Stay, StayQuery } from "@tickets/shared";
import {
  ArrowLeft,
  ArrowUpRight,
  BedDouble,
  CalendarDays,
  Clock,
  Info,
  Luggage,
  MapPin,
  Star,
  Store,
} from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { FavoriteToggle, FavoritesProvider } from "@/components/favorites";
import { SiteFooter } from "@/components/page-chrome";
import { PageNotice } from "@/components/page-notice";
import { FreshnessBadge } from "@/components/price-freshness";
import { SiteHeader } from "@/components/site-header";
import { isGoogleHotels, RatingBadge, StayDetails } from "@/components/stay-card";
import { PriceHistoryChart } from "@/components/price-history-chart";
import { StayGallery } from "@/components/stay-gallery";
import { StayHotelRates } from "@/components/stay-hotel-rates";
import { Button } from "@/components/ui/button";
import { ERROR_KEY, fetchStayDetail, fetchStayHistory } from "@/lib/api";
import { favoriteSnapshot } from "@/lib/favorites";
import { fractionDigits } from "@/lib/money";
import { outboundHref } from "@/lib/outbound";
import type { RawSearchParams } from "@/lib/search-params";
import { parseStayParams, parseStayRef, toStayParams } from "@/lib/stay-params";
import { tripFromStay } from "@/lib/trip-params";

/**
 * Сторінка об'єкта житла (ADR 0044): фото, опис, деталі, ціни продавців і перехід на сайт.
 * Об'єкт — з тієї самої видачі (параметри пошуку в URL + `src`/`id`), тож платне джерело
 * відповідає з кешу пошуку; тарифи продавців підвантажуються самі.
 */
export default function StayHotelPage({ searchParams }: PageProps<"/[locale]/stays/hotel">) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <SiteHeader active="stays" />
      <main id="main" tabIndex={-1} className="flex-1 outline-none">
        <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:py-8">
          <FavoritesProvider>
            <Suspense fallback={<HotelSkeleton />}>
              <Hotel searchParams={searchParams} />
            </Suspense>
          </FavoritesProvider>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

async function Hotel({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const raw = await searchParams;
  const state = parseStayParams(raw);
  const ref = parseStayRef(raw);
  const t = await getTranslations("stayHotel");
  if (!state || !ref) {
    return (
      <div className="grid gap-4">
        <h1 className="sr-only">{t("title")}</h1>
        <PageNotice>{t("invalid")}</PageNotice>
      </div>
    );
  }
  const params = toStayParams(state).toString();
  const backHref = `/stays?${params}`;
  const back = (
    <Link
      href={backHref}
      className="text-muted-foreground hover:text-primary flex w-fit items-center gap-1.5 text-sm transition-colors"
      data-testid="stay-hotel-back"
    >
      <ArrowLeft className="size-4" aria-hidden />
      {t("back")}
    </Link>
  );

  const result = await fetchStayDetail({
    query: state.query,
    source: ref.source,
    stay_id: ref.id,
  });
  if (!result.ok || result.data.status !== "ok" || !result.data.stay) {
    const message = !result.ok
      ? t(ERROR_KEY[result.reason])
      : result.data.status === "not_found"
        ? t("notFound")
        : result.data.status === "rate_limited"
          ? t("rateLimited")
          : result.data.status === "unsupported"
            ? t("unsupported")
            : t("failed");
    return (
      <div className="grid gap-4">
        {back}
        <h1 className="sr-only">{t("title")}</h1>
        <PageNotice tone={result.ok && result.data.status === "not_found" ? "info" : "error"}>
          {message}
        </PageNotice>
      </div>
    );
  }

  const { stay, freshness } = result.data;
  const now = new Date();
  // Тарифи: mock — завжди (`sellers`), Google Hotels — коли є токен продавців.
  const hasRates = stay.sellers != null || stay.booking_ref != null;
  return (
    <article className="animate-in fade-in-0 grid gap-6 duration-300" data-testid="stay-hotel">
      {back}
      <HotelHeading stay={stay} place={result.data.place?.name ?? state.query.city} />
      <StayGallery photos={stay.images?.length ? stay.images : []} name={stay.name} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <div className="grid gap-6">
          <section className="grid gap-2" aria-labelledby="hotel-about">
            <h2 id="hotel-about" className="text-lg font-semibold">
              {t("about")}
            </h2>
            {stay.description ? (
              <p className="leading-relaxed" data-testid="stay-description">
                {stay.description}
              </p>
            ) : (
              <p className="text-muted-foreground text-sm">{t("noDescription")}</p>
            )}
          </section>

          <section className="grid gap-3" aria-labelledby="hotel-rooms" id="rooms">
            <div className="grid gap-0.5">
              <h2 id="hotel-rooms" className="text-lg font-semibold">
                {t("rooms")}
              </h2>
              <p className="text-muted-foreground text-xs">
                {t("roomsHint", {
                  nights: stay.nights,
                  guests: (state.query.guests?.adults ?? 2) + (state.query.guests?.children ?? 0),
                })}
              </p>
            </div>
            {hasRates ? (
              <StayHotelRates
                query={state.query}
                source={stay.source}
                stayId={stay.id}
                now={now.toISOString()}
              />
            ) : (
              <p className="text-muted-foreground text-sm">{t("noRates")}</p>
            )}
          </section>

          {/* Історія ціни на ці дати (етап 6) — збережені спостереження видачі. */}
          <Suspense fallback={null}>
            <StayHistory stay={stay} query={state.query} />
          </Suspense>

          <section className="grid gap-3" aria-labelledby="hotel-details">
            <h2 id="hotel-details" className="text-lg font-semibold">
              {t("details")}
            </h2>
            <div className="bg-card rounded-xl border p-4">
              <StayDetails stay={stay} now={now} />
            </div>
          </section>
        </div>

        <PriceAside
          stay={stay}
          query={state.query}
          params={params}
          freshness={freshness ?? undefined}
        />
      </div>
    </article>
  );
}

async function StayHistory({ stay, query }: { stay: Stay; query: StayQuery }) {
  const result = await fetchStayHistory({
    source: stay.source,
    stayId: stay.id,
    checkIn: query.check_in,
    checkOut: query.check_out,
    guests: (query.guests?.adults ?? 2) + (query.guests?.children ?? 0),
    currency: stay.currency,
  });
  if (!result.ok) return null;
  const t = await getTranslations("priceHistory");
  return (
    <section className="bg-card rounded-xl border p-4" data-testid="stay-history">
      <PriceHistoryChart series={result.data} title={t("stayTitle")} testId="stay-price-history" />
    </section>
  );
}

function HotelHeading({ stay, place }: { stay: Stay; place: string }) {
  const t = useTranslations("stayHotel");
  const tCard = useTranslations("stayCard");
  const format = useFormatter();
  return (
    <header className="grid gap-2">
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="text-primary font-semibold tracking-wide uppercase">
          {tCard(`kind.${stay.kind}`)}
        </span>
        {stay.stars != null && (
          <span
            className="flex items-center gap-0.5"
            role="img"
            aria-label={tCard("stars", { count: stay.stars })}
          >
            {Array.from({ length: stay.stars }, (_, i) => (
              <Star key={i} className="size-3 fill-amber-400 text-amber-400" aria-hidden />
            ))}
          </span>
        )}
        <span>· {place}</span>
      </div>
      <h1 className="text-2xl font-bold tracking-tight text-balance sm:text-3xl">{stay.name}</h1>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <RatingBadge rating={stay.rating ?? null} reviews={stay.review_count ?? 0} />
        <span className="text-muted-foreground flex items-center gap-1">
          <MapPin className="size-3.5" aria-hidden />
          {stay.address ?? stay.district ?? null}
          {(stay.address ?? stay.district) && stay.distance_to_center_km != null ? " · " : null}
          {stay.distance_to_center_km != null
            ? tCard("toCenter", { km: format.number(stay.distance_to_center_km) })
            : null}
        </span>
        {(stay.check_in_time || stay.check_out_time) && (
          <span className="text-muted-foreground flex items-center gap-1">
            <Clock className="size-3.5" aria-hidden />
            {t("checkTimes", {
              in: stay.check_in_time ?? tCard("unknown"),
              out: stay.check_out_time ?? tCard("unknown"),
            })}
          </span>
        )}
      </div>
    </header>
  );
}

function PriceAside({
  stay,
  query,
  params,
  freshness,
}: {
  stay: Stay;
  query: StayQuery;
  params: string;
  freshness: Parameters<typeof FreshnessBadge>[0]["value"];
}) {
  const t = useTranslations("stayHotel");
  const tCard = useTranslations("stayCard");
  const format = useFormatter();
  const money = (value: number) =>
    format.number(value, {
      style: "currency",
      currency: stay.currency,
      currencyDisplay: "narrowSymbol",
      ...fractionDigits(value),
    });
  const date = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  return (
    <aside
      className="bg-card grid gap-4 rounded-xl border p-5 shadow-sm lg:sticky lg:top-20"
      data-testid="stay-hotel-price"
    >
      <div>
        <p className="text-3xl font-bold tracking-tight tabular-nums">
          {money(stay.price_per_night)}
        </p>
        <p className="text-muted-foreground text-xs">{tCard("perNight")}</p>
        <p className="mt-1 font-medium tabular-nums">
          {tCard("total", { nights: stay.nights, total: money(stay.total_price) })}
        </p>
        <p className="text-muted-foreground text-[11px]">
          {stay.taxes_included === true ? tCard("withTaxes") : tCard("taxesUnknown")}
        </p>
      </div>
      <p className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
        <CalendarDays className="size-3.5" aria-hidden />
        {date(query.check_in)} – {date(query.check_out)}
      </p>
      <div className="grid gap-1.5 text-xs">
        <FreshnessBadge value={freshness ?? undefined} />
        <p className="text-muted-foreground flex items-start gap-1.5">
          <Store className="mt-px size-3.5 shrink-0" aria-hidden />
          {tCard("via", {
            service: stay.source === "scrapedo" ? tCard("source.scrapedo") : stay.source,
          })}
        </p>
      </div>
      <div className="grid gap-2">
        <Button asChild variant="outline">
          <a href="#rooms">
            <BedDouble className="size-4" aria-hidden />
            {t("seeRooms")}
          </a>
        </Button>
        {stay.deep_link && (
          <Button asChild>
            <a
              href={outboundHref(stay.deep_link, "stay", stay.source)}
              target="_blank"
              rel="noopener noreferrer nofollow"
              data-testid="stay-hotel-site"
            >
              {isGoogleHotels(stay.deep_link) ? tCard("openGoogleHotels") : tCard("book")}
              <ArrowUpRight className="size-4" aria-hidden />
            </a>
          </Button>
        )}
        <div className="flex flex-wrap gap-2">
          <FavoriteToggle body={{ kind: "stay", stay: favoriteSnapshot(stay, query, params) }} />
          <Button asChild variant="outline" size="sm">
            <Link href={tripFromStay(stay, query)}>
              <Luggage className="size-3.5" aria-hidden />
              {tCard("addToTrip")}
            </Link>
          </Button>
        </div>
      </div>
      <p className="text-muted-foreground flex items-start gap-1.5 text-[11px] leading-snug">
        <Info className="mt-px size-3 shrink-0" aria-hidden />
        {tCard("partnerNote")}
      </p>
    </aside>
  );
}

function HotelSkeleton() {
  return (
    <div className="grid gap-6" aria-busy>
      <div className="grid gap-2">
        <div className="shimmer h-3 w-40 rounded" />
        <div className="shimmer h-8 w-2/3 rounded" />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="shimmer col-span-2 h-64 rounded-xl" />
        <div className="shimmer h-32 rounded-xl" />
        <div className="shimmer h-32 rounded-xl" />
      </div>
    </div>
  );
}
