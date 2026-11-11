import type { ExploreQuery, ExploreResult } from "@tickets/shared";
import { Compass, List, Map as MapIcon } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { after, connection } from "next/server";
import { Suspense } from "react";

import { AIChat } from "@/components/ai-chat";
import { CollapsibleSearch } from "@/components/collapsible-search";
import { SearchTabs } from "@/components/search-tabs";
import { ExploreCard } from "@/components/explore-card";
import { ExploreCompareBar, ExploreCompareProvider } from "@/components/explore-compare";
import { EntryNotice } from "@/components/entry-notice";
import { ExploreFeatured } from "@/components/explore-featured";
import { ExploreForm } from "@/components/explore-form";
import { FavoritesProvider } from "@/components/favorites";
import { FeatureHint } from "@/components/feature-hint";
import { SaveSearch } from "@/components/save-search";
import { ExploreMapLazy } from "@/components/explore-map-lazy";
import type { MapDestination } from "@/components/explore-map";
import { InfoHint } from "@/components/info-hint";
import { HeroBackdrop, SiteFooter } from "@/components/page-chrome";
import { PageNotice } from "@/components/page-notice";
import { ProviderAlerts } from "@/components/provider-alerts";
import { SearchModes } from "@/components/search-modes";
import { SiteHeader } from "@/components/site-header";
import { Card, CardContent } from "@/components/ui/card";
import { ERROR_KEY, fetchAIStatus, searchExplore } from "@/lib/api";
import {
  CATEGORIES,
  EXPLORE_PATH,
  exploreHref,
  exploreRelaxations,
  flightsHref,
  parseExploreDraft,
  parseExploreParams,
  toExploreParams,
  toggleCategory,
  tripHref,
  withMode,
} from "@/lib/explore-params";
import type { RawSearchParams } from "@/lib/search-params";
import { searchEvents } from "@/lib/server-analytics";
import { recordHistory, sessionToken } from "@/lib/session";
import { dateRange } from "@/lib/summary";
import { currentAccount } from "@/lib/session";
import { cn } from "@/lib/utils";

type Params = Promise<RawSearchParams>;

/**
 * Explore (ADR 0045): куди полетіти за бюджетом. Ціни перельотів — кешовані (Travelpayouts,
 * без квоти), житло — лише для трьох найдешевших напрямків у режимі «авіаквитки + житло».
 * Перехід до рейсів чи Smart Trip Builder перевіряє ціни живими джерелами.
 */
export default function ExplorePage({ searchParams }: PageProps<"/[locale]/explore">) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <SiteHeader active="explore" />
      <main id="main" tabIndex={-1} className="flex-1 outline-none">
        <section className="relative isolate overflow-hidden border-b">
          <HeroBackdrop />
          <div className="mx-auto grid w-full max-w-6xl gap-5 px-4 py-5 sm:py-8">
            <Suspense fallback={null}>
              <HeroText searchParams={searchParams} />
            </Suspense>
            <Card className="border-primary/10 shadow-primary/[0.07] overflow-visible py-0 shadow-xl ring-0">
              <CardContent className="px-4 py-4 sm:px-6 sm:py-5">
                <Suspense fallback={<div className="shimmer h-56 rounded-lg" aria-hidden />}>
                  <SearchArea searchParams={searchParams} />
                </Suspense>
              </CardContent>
            </Card>
          </div>
        </section>

        <div className="mx-auto w-full max-w-6xl px-4 py-8">
          <FavoritesProvider>
            <ExploreCompareProvider>
              <Suspense fallback={<ResultsSkeleton />}>
                <Results searchParams={searchParams} />
              </Suspense>
              <ExploreCompareBar />
            </ExploreCompareProvider>
          </FavoritesProvider>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

async function HeroText({ searchParams }: { searchParams: Params }) {
  const t = await getTranslations("explore");
  if (parseExploreParams(await searchParams)) {
    return <h1 className="sr-only">{t("resultsHeading")}</h1>;
  }
  return (
    <div className="grid gap-1.5">
      <h1 className="text-2xl font-bold tracking-tight text-balance sm:text-4xl">
        {t.rich("title", {
          accent: (chunks) => (
            <span className="from-primary bg-gradient-to-r to-sky-500 bg-clip-text text-transparent">
              {chunks}
            </span>
          ),
        })}
      </h1>
      <p className="text-muted-foreground max-w-2xl text-sm text-balance sm:text-base">
        {t("subtitle")}
      </p>
    </div>
  );
}

async function SearchArea({ searchParams }: { searchParams: Params }) {
  const [raw, account] = await Promise.all([searchParams, currentAccount(), connection()]);
  const query = parseExploreParams(raw);
  const draft = parseExploreDraft(raw);
  // Новий пошук — з домашнього аеропорту кабінету (модуль 15), відкритий з URL — як є.
  if (!draft.origins?.length && account?.home_airport) draft.origins = [account.home_airport];
  const today = new Date().toISOString().slice(0, 10);
  const locale = await getLocale();
  const country = (query ?? draft).country;
  const form = (
    <ExploreForm
      key={query ? exploreHref(query) : "empty"}
      initial={query ?? draft}
      countryName={
        country ? new Intl.DisplayNames([locale], { type: "region" }).of(country) : undefined
      }
      today={today}
    />
  );
  // Перемикач режимів: у рейси/житло/поїздку — звідки, дати й люди цього пошуку.
  const common = {
    from: (query ?? draft).origins?.[0],
    to: undefined,
    depart: (query ?? draft).departure_date,
    return: (query ?? draft).return_date ?? undefined,
    adults: (query ?? draft).adults,
  };
  const status = await fetchAIStatus();
  // ШІ-помічник (етап 8): той самий чат «Квитки», що вміє шукати напрямки (`explore_destinations`).
  const withModes = (inner: React.ReactNode) => (
    <SearchModes current="explore" common={common} ai={status.enabled} drafting={!query}>
      {status.enabled ? (
        <SearchTabs
          form={inner}
          chat={<AIChat homeAirport={(query ?? draft).origins?.[0] ?? undefined} />}
        />
      ) : (
        inner
      )}
    </SearchModes>
  );
  if (!query) return withModes(form);
  const t = await getTranslations("explore");
  const { where, details } = await summary(query);
  return withModes(
    <CollapsibleSearch
      title={t("summaryTitle", { from: query.origins.join(", "), to: where })}
      details={details}
    >
      {form}
    </CollapsibleSearch>,
  );
}

async function summary(query: ExploreQuery): Promise<{ where: string; details: string }> {
  const t = await getTranslations("explore.summary");
  const tRegion = await getTranslations("explore.region");
  const locale = await getLocale();
  const where = query.region
    ? tRegion(query.region)
    : query.country
      ? (new Intl.DisplayNames([locale], { type: "region" }).of(query.country) ?? query.country)
      : t("anywhere");
  const when = query.return_date
    ? await dateRange(query.departure_date, query.return_date)
    : t("flexible", {
        dates: await dateRange(query.departure_date, query.departure_until),
        min: query.min_nights ?? 1,
        max: query.max_nights ?? 1,
      });
  return { where, details: [when, t("adults", { count: query.adults ?? 1 })].join(" · ") };
}

async function Results({ searchParams }: { searchParams: Params }) {
  const raw = await searchParams;
  const query = parseExploreParams(raw);
  const t = await getTranslations("explore");
  if (!query) {
    const meaningful = Object.keys(raw).some((k) => !["cat", "to", "mode", "from"].includes(k));
    if (meaningful) return <PageNotice>{t("invalid")}</PageNotice>;
    const [account] = await Promise.all([currentAccount(), connection()]);
    const draft = parseExploreDraft(raw);
    return (
      <div className="grid gap-10">
        <Suspense fallback={<FeaturedSkeleton />}>
          <ExploreFeatured
            origin={draft.origins?.[0] ?? account?.home_airport ?? null}
            scope={{ region: draft.region, country: draft.country, categories: draft.categories }}
            currency={account?.currency ?? "EUR"}
            today={new Date().toISOString().slice(0, 10)}
          />
        </Suspense>
        <Ideas />
      </div>
    );
  }
  const locale = await getLocale();
  const result = await searchExplore({ ...query, lang: locale === "uk" ? "uk" : "en" });
  after(
    await searchEvents(
      "explore",
      result.ok
        ? { ok: true, results: result.data.destinations.length }
        : { ok: false, reason: result.reason },
    ),
  );
  if (!result.ok) {
    return (
      <PageNotice tone="error" retryHref={exploreHref(query)}>
        {t(ERROR_KEY[result.reason])}
      </PageNotice>
    );
  }
  const view = raw.view === "map" ? "map" : "list";
  // Історія пошуків кабінету (етап 7): Explore — окремий вид.
  const params = toExploreParams(query).toString();
  const { where, details } = await summary(query);
  const title =
    `${t("summaryTitle", { from: query.origins.join(", "), to: where })} · ${details}`.slice(
      0,
      120,
    );
  after(recordHistory(await sessionToken(), { kind: "explore", params, title }));
  return (
    <ResultsView
      query={query}
      data={result.data}
      view={view}
      locale={locale}
      save={<SaveSearch kind="explore" params={params} title={title} back={`/explore?${params}`} />}
    />
  );
}

function ResultsView({
  query,
  data,
  view,
  locale,
  save,
}: {
  query: ExploreQuery;
  data: ExploreResult;
  view: "list" | "map";
  locale: string;
  save?: React.ReactNode;
}) {
  const t = useTranslations("explore");
  const format = useFormatter();
  const countries = new Intl.DisplayNames([locale], { type: "region" });
  const country = (code: string) => (code ? (countries.of(code) ?? code) : "");
  const destinations = data.destinations;
  const date = (iso: string) =>
    format.dateTime(new Date(`${iso.slice(0, 10)}T00:00:00Z`), {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  const mapItems: MapDestination[] = destinations.flatMap((d) =>
    d.lat != null && d.lon != null
      ? [
          {
            code: d.code,
            city: d.city_name,
            country: country(d.country),
            lat: d.lat,
            lon: d.lon,
            price: query.mode === "trip" && d.total != null ? d.total : d.offer.price,
            currency: d.offer.currency,
            dates: `${date(d.offer.outbound.departure_at)} – ${date(d.offer.inbound?.departure_at ?? d.offer.outbound.departure_at)}`,
            flightsHref: flightsHref(d, query),
            tripHref: tripHref(d, query),
          },
        ]
      : [],
  );
  const relax = exploreRelaxations(query);
  const tab =
    "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors";

  return (
    <div className="animate-in fade-in-0 grid gap-5 duration-300" data-testid="explore-results">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="text-2xl font-bold tracking-tight">{t("found", { count: data.found })}</h2>
          <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
            <p>{t("cachedNote")}</p>
            <InfoHint label={t("howTitle")}>{t("howText")}</InfoHint>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {save}
          <nav aria-label={t("modeLabel")} className="bg-muted flex gap-1 rounded-lg p-1">
            {(["flights", "trip"] as const).map((mode) => (
              <Link
                key={mode}
                href={exploreHref(withMode(query, mode), view)}
                aria-current={(query.mode ?? "flights") === mode ? "page" : undefined}
                className={cn(
                  tab,
                  (query.mode ?? "flights") === mode
                    ? "bg-card text-primary shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                data-testid={`explore-mode-${mode}`}
              >
                {t(`form.modes.${mode}`)}
              </Link>
            ))}
          </nav>
          <nav aria-label={t("viewLabel")} className="bg-muted flex gap-1 rounded-lg p-1">
            {(["list", "map"] as const).map((v) => {
              const Icon = v === "map" ? MapIcon : List;
              return (
                <Link
                  key={v}
                  href={exploreHref(query, v)}
                  aria-current={view === v ? "page" : undefined}
                  className={cn(
                    tab,
                    view === v
                      ? "bg-card text-primary shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  data-testid={`explore-view-${v}`}
                >
                  <Icon className="size-4" aria-hidden />
                  {t(`view.${v}`)}
                </Link>
              );
            })}
          </nav>
        </div>
      </div>

      <FeatureHint id="explore" />
      <CategoryChips query={query} view={view} />
      <ProviderAlerts providers={data.providers} />
      {query.mode === "trip" && data.stays_checked > 0 && (
        <p className="bg-accent/60 text-accent-foreground rounded-lg px-3 py-2 text-xs">
          {t("staysChecked", { count: data.stays_checked })}
        </p>
      )}

      {destinations.length === 0 ? (
        <div
          className="grid gap-3 rounded-xl border border-dashed p-6 text-center"
          data-testid="explore-empty"
        >
          <p className="font-medium">{t("empty")}</p>
          {relax.length > 0 && (
            <div className="flex flex-wrap justify-center gap-2">
              {relax.slice(0, 4).map((r) => (
                <Link
                  key={r.key}
                  href={exploreHref(r.query, view)}
                  className="hover:border-primary hover:text-primary rounded-full border px-3 py-1 text-sm"
                  data-testid="explore-relax"
                >
                  {t(`relax.${r.key}`)}
                </Link>
              ))}
            </div>
          )}
        </div>
      ) : view === "map" ? (
        <ExploreMapLazy
          key={exploreHref(query)}
          destinations={mapItems}
          listHref={exploreHref(query)}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {destinations.map((d) => (
            <ExploreCard
              key={d.code}
              destination={d}
              query={query}
              countryName={country(d.country)}
            />
          ))}
        </div>
      )}
      {destinations.length > 0 && destinations.length < 4 && relax.length > 0 && (
        <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
          {t("few")}
          {relax.slice(0, 2).map((r) => (
            <Link
              key={r.key}
              href={exploreHref(r.query, view)}
              className="text-primary hover:underline"
            >
              {t(`relax.${r.key}`)}
            </Link>
          ))}
        </p>
      )}
      <EntryNotice />
    </div>
  );
}

function CategoryChips({ query, view }: { query: ExploreQuery; view: "list" | "map" }) {
  const t = useTranslations("explore");
  const tCat = useTranslations("explore.category");
  return (
    <nav aria-label={t("categoriesLabel")} className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
      {CATEGORIES.map((c) => {
        const on = query.categories?.includes(c) ?? false;
        return (
          <Link
            key={c}
            href={exploreHref(toggleCategory(query, c), view)}
            aria-current={on ? "true" : undefined}
            className={cn(
              "shrink-0 rounded-full border px-3 py-1 text-sm font-medium transition-colors",
              on ? "border-primary bg-primary/10 text-primary" : "hover:border-primary/60",
            )}
            data-testid="explore-category"
          >
            {tCat(c)}
          </Link>
        );
      })}
    </nav>
  );
}

/** Без пошуку — візуальні категорії: обирають категорію у формі (пошук — лише кнопкою). */
function Ideas() {
  const t = useTranslations("explore");
  const tCat = useTranslations("explore.category");
  return (
    <section className="grid gap-4" aria-labelledby="explore-ideas">
      <h2 id="explore-ideas" className="flex items-center gap-2 text-lg font-semibold">
        <Compass className="text-primary size-5" aria-hidden />
        {t("ideasTitle")}
      </h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {CATEGORIES.map((c) => (
          <Link
            key={c}
            href={`${EXPLORE_PATH}?cat=${c}`}
            className="bg-card lift grid gap-1 rounded-xl border p-4"
            data-testid="explore-idea"
          >
            <span className="font-semibold">{tCat(c)}</span>
            <span className="text-muted-foreground text-xs">{t(`categoryHint.${c}`)}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function FeaturedSkeleton() {
  return (
    <div className="grid gap-4" aria-busy>
      <div className="shimmer aspect-[4/5] rounded-2xl sm:aspect-[21/9]" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className={cn("shimmer h-56 rounded-xl", i === 4 && "max-lg:hidden")} />
        ))}
      </div>
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="shimmer h-80 rounded-xl" />
      ))}
    </div>
  );
}
