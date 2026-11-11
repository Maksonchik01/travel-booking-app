import type { ExploreQuery } from "@tickets/shared";
import { ArrowRight, Compass } from "lucide-react";
import Link from "next/link";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";

import { fetchCategoryCovers, searchExplore } from "@/lib/api";
import { datePreset } from "@/lib/date-presets";
import { EXPLORE_LIMIT, exploreHref, flightsHref } from "@/lib/explore-params";
import { fractionDigits } from "@/lib/money";
import { currentAccount } from "@/lib/session";

const COLLECTION_SIZE = 4;
const CHEAP_BUDGET = 150;

/**
 * Ідеї для подорожі на головній (етап 9): категорії з фото → Explore; з домашнім аеропортом —
 * дві добірки з реальних (кешованих) цін Explore: вихідні наступного місяця й «до 150 €».
 * Без аеропорту цін не вигадуємо — лише категорії.
 */
export async function TravelIdeas() {
  const [covers, account, t, locale] = await Promise.all([
    fetchCategoryCovers(),
    currentAccount(),
    getTranslations("ideas"),
    getLocale(),
  ]);
  const tCat = await getTranslations("explore.category");
  const home = account?.home_airport ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const base = (extra: Partial<ExploreQuery>): ExploreQuery => ({
    origins: [home ?? "WAW"],
    departure_date: today,
    adults: 1,
    mode: "flights",
    weekends: false,
    direct_only: false,
    currency: account?.currency ?? "EUR",
    lang: locale === "uk" ? "uk" : "en",
    limit: EXPLORE_LIMIT,
    ...extra,
  });
  const weekends = datePreset("monthWeekends", today);
  const collections = home
    ? [
        {
          key: "weekends",
          query: base({
            departure_date: weekends.depart,
            departure_until: weekends.until,
            min_nights: 1,
            max_nights: 3,
            weekends: true,
          }),
        },
        {
          key: "cheap",
          query: base({
            departure_date: datePreset("short", today).depart,
            departure_until: datePreset("short", today).until,
            min_nights: 2,
            max_nights: 7,
            budget: CHEAP_BUDGET,
          }),
        },
      ]
    : [];
  const results = await Promise.all(collections.map((c) => searchExplore(c.query)));
  const format = await getFormatter();
  const exploreBase = home ? `&from=${home}` : "";

  return (
    <section className="grid gap-5" aria-labelledby="ideas-title" data-testid="travel-ideas">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2
          id="ideas-title"
          className="flex items-center gap-2 text-xl font-semibold tracking-tight"
        >
          <Compass className="text-primary size-5" aria-hidden />
          {t("title")}
        </h2>
        <Link
          href="/explore"
          className="text-primary flex items-center gap-1 text-sm font-medium hover:underline"
        >
          {t("allExplore")}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {covers.map((cover) => (
          <li key={cover.category}>
            <Link
              href={`/explore?cat=${cover.category}${exploreBase}`}
              className="group lift relative block aspect-[4/5] overflow-hidden rounded-xl border"
              data-testid="idea-category"
            >
              {/* Фото з довідника напрямків (upload.wikimedia.org), без Referer. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={cover.photo.url}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                className="absolute inset-0 size-full object-cover transition-transform duration-500 group-hover:scale-105"
              />
              <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent p-3 pt-10 text-sm font-semibold text-white">
                {tCat(cover.category)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {collections.map((collection, i) => {
        const result = results[i];
        if (!result.ok || result.data.destinations.length === 0) return null;
        const query = collection.query;
        return (
          <div
            key={collection.key}
            className="grid gap-3"
            data-testid={`idea-collection-${collection.key}`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-semibold">
                {t(`collection.${collection.key}`, { from: home ?? "", budget: CHEAP_BUDGET })}
              </h3>
              <Link href={exploreHref(query)} className="text-primary text-sm hover:underline">
                {t("more")}
              </Link>
            </div>
            <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {result.data.destinations.slice(0, COLLECTION_SIZE).map((d) => (
                <li key={d.code}>
                  <Link
                    href={flightsHref(d, query)}
                    className="bg-card lift grid overflow-hidden rounded-xl border"
                  >
                    {d.photo && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={d.photo.url}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="aspect-[16/10] w-full object-cover"
                      />
                    )}
                    <span className="grid gap-0.5 p-3">
                      <span className="font-semibold">{d.city_name}</span>
                      <span className="text-muted-foreground text-xs">
                        {t("nights", { count: d.nights })}
                      </span>
                      <span className="font-bold tabular-nums">
                        {t("from", {
                          price: format.number(d.offer.price, {
                            style: "currency",
                            currency: d.offer.currency,
                            currencyDisplay: "narrowSymbol",
                            ...fractionDigits(d.offer.price),
                          }),
                        })}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {!home && <p className="text-muted-foreground text-xs">{t("homeHint")}</p>}
    </section>
  );
}
