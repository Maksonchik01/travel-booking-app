import type { ExploreDestination, ExploreQuery } from "@tickets/shared";
import { ArrowRight, CalendarDays, Sparkles } from "lucide-react";
import Link from "next/link";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";

import { EntryNotice } from "@/components/entry-notice";
import { searchExplore } from "@/lib/api";
import { shiftDay } from "@/lib/date-presets";
import { EXPLORE_LIMIT, exploreHref, featuredPicks, flightsHref } from "@/lib/explore-params";
import { fractionDigits } from "@/lib/money";
import { cn } from "@/lib/utils";

/** Без свого аеропорту — ціни з Варшави (підписано; людина змінює місто у формі). */
const FALLBACK_ORIGIN = "WAW";
const WINDOW = { from: 7, to: 60 } as const;
const NIGHTS = [2, 7] as const;

/**
 * Пропозиції одразу на Explore (ADR 0054): реальні кешовані ціни Explore з міста вильоту на
 * найближчі два місяці — велика картка найвигіднішого напрямку з фото й ще п'ять схожих.
 * Картка: фото міста, ціна туди й назад, дати. Клік — пошук рейсів на ці дати (живі джерела).
 */
export async function ExploreFeatured({
  origin,
  scope,
  currency,
  today,
}: {
  /** Місто з форми чи кабінету; null — запасне (підписуємо). */
  origin: string | null;
  scope: Pick<ExploreQuery, "region" | "country" | "categories">;
  currency: ExploreQuery["currency"];
  /** Сьогодні (YYYY-MM-DD) — рахує сторінка після читання запиту (cacheComponents). */
  today: string;
}) {
  const [t, locale, format] = await Promise.all([
    getTranslations("explore.featured"),
    getLocale(),
    getFormatter(),
  ]);
  const query: ExploreQuery = {
    origins: [origin ?? FALLBACK_ORIGIN],
    ...scope,
    departure_date: shiftDay(today, WINDOW.from),
    departure_until: shiftDay(today, WINDOW.to),
    min_nights: NIGHTS[0],
    max_nights: NIGHTS[1],
    adults: 1,
    mode: "flights",
    weekends: false,
    direct_only: false,
    currency: currency ?? "EUR",
    lang: locale === "uk" ? "uk" : "en",
    limit: EXPLORE_LIMIT,
  };
  const result = await searchExplore(query);
  if (!result.ok) return null;
  const picks = featuredPicks(result.data.destinations);
  if (!picks) return null;
  const countries = new Intl.DisplayNames([locale], { type: "region" });
  const country = (code: string) => (code ? (countries.of(code) ?? code) : "");
  const money = (d: ExploreDestination) =>
    format.number(d.offer.price, {
      style: "currency",
      currency: d.offer.currency,
      currencyDisplay: "narrowSymbol",
      ...fractionDigits(d.offer.price),
    });
  const dates = (d: ExploreDestination) => {
    const day = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`);
    const back = d.offer.inbound?.departure_at ?? d.offer.outbound.departure_at;
    return format.dateTimeRange(day(d.offer.outbound.departure_at), day(back), {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  };
  const hero = picks.hero;

  return (
    <section
      className="grid gap-4"
      aria-labelledby="explore-featured"
      data-testid="explore-featured"
    >
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="grid gap-0.5">
          <h2 id="explore-featured" className="flex items-center gap-2 text-xl font-semibold">
            <Sparkles className="text-primary size-5" aria-hidden />
            {t("title", { from: query.origins[0] })}
          </h2>
          <p className="text-muted-foreground text-xs">
            {origin ? t("subtitle") : t("fallback", { from: FALLBACK_ORIGIN })}
          </p>
        </div>
        <Link
          href={exploreHref(query)}
          className="text-primary flex items-center gap-1 text-sm font-medium hover:underline"
        >
          {t("all")}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>

      <Link
        href={flightsHref(hero, query)}
        className="group lift relative isolate block aspect-[4/5] overflow-hidden rounded-2xl border shadow-lg sm:aspect-[21/9]"
        data-testid="explore-featured-hero"
      >
        {/* Фото з довідника напрямків (upload.wikimedia.org), без Referer. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={hero.photo!.url}
          alt=""
          referrerPolicy="no-referrer"
          className="absolute inset-0 -z-10 size-full object-cover transition-transform duration-700 group-hover:scale-105"
        />
        <span className="absolute inset-0 -z-10 bg-gradient-to-t from-black/80 via-black/25 to-transparent" />
        <span className="flex h-full flex-col justify-end gap-2 p-5 text-white sm:p-8">
          {picks.cheapest && (
            <span className="bg-primary text-primary-foreground w-fit rounded-full px-2.5 py-0.5 text-xs font-semibold">
              {t("cheapest")}
            </span>
          )}
          <span className="text-3xl font-bold tracking-tight sm:text-5xl">{hero.city_name}</span>
          <span className="text-sm text-white/85">{country(hero.country)}</span>
          <span className="flex flex-wrap items-end justify-between gap-3">
            <span className="flex items-center gap-1.5 text-sm text-white/90">
              <CalendarDays className="size-4" aria-hidden />
              {dates(hero)} · {t("nights", { count: hero.nights })}
            </span>
            <span className="grid justify-items-end">
              <span className="text-xs text-white/80">{t("roundTrip")}</span>
              <span className="text-3xl font-bold tabular-nums sm:text-4xl">
                {t("from", { price: money(hero) })}
              </span>
            </span>
          </span>
        </span>
      </Link>

      {picks.similar.length > 0 && (
        <div className="grid gap-3">
          <h3 className="font-semibold">{t("similar")}</h3>
          <ul className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            {picks.similar.map((d, i) => (
              // Два стовпці — чотири картки, п'ята лише в ряд з п'яти.
              <li key={d.code} className={cn(i === 4 && "max-lg:hidden")}>
                <Link
                  href={flightsHref(d, query)}
                  className="bg-card lift group grid h-full overflow-hidden rounded-xl border"
                  data-testid="explore-featured-card"
                >
                  <span className="relative block aspect-[4/3] overflow-hidden">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={d.photo!.url}
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      className="size-full object-cover transition-transform duration-500 group-hover:scale-105"
                    />
                  </span>
                  <span className="grid gap-1 p-3">
                    <span className="leading-tight font-semibold">{d.city_name}</span>
                    <span className="text-muted-foreground text-xs">{country(d.country)}</span>
                    <span className="text-lg font-bold tabular-nums">
                      {t("from", { price: money(d) })}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {dates(d)} · {t("nights", { count: d.nights })}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid gap-1">
        <p className="text-muted-foreground text-[11px]">{t("note")}</p>
        <EntryNotice />
      </div>
    </section>
  );
}
