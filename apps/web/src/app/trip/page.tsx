import type { StayQuery, TripCombo, TripQuery, TripSearchResult } from "@tickets/shared";
import { CalendarDays, Info, Luggage, Plane, Scale, Sparkles, Wallet } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { after } from "next/server";
import { Suspense } from "react";

import { AIChat } from "@/components/ai-chat";
import { CollapsibleSearch } from "@/components/collapsible-search";
import { HeroBackdrop, SiteFooter } from "@/components/page-chrome";
import { ProviderAlerts } from "@/components/provider-alerts";
import { SaveSearch } from "@/components/save-search";
import { SearchTabs } from "@/components/search-tabs";
import { SiteHeader } from "@/components/site-header";
import { SavedTripsProvider } from "@/components/saved-trips";
import { TripBuilder } from "@/components/trip-builder";
import { TripCompareBar, TripCompareProvider, TripCompareToggle } from "@/components/trip-compare";
import { TripCard } from "@/components/trip-card";
import { TripUndo } from "@/components/trip-history";
import { TripSearchForm } from "@/components/trip-search-form";
import { Card, CardContent } from "@/components/ui/card";
import { ERROR_KEY, fetchAIStatus, searchTrip } from "@/lib/api";
import { type RawSearchParams, toSearchParams } from "@/lib/search-params";
import { toStayParams } from "@/lib/stay-params";
import { tripSnapshot } from "@/lib/saved-trips";
import {
  parseTripDraft,
  parseTripParams,
  savedId,
  toTripParams,
  withChoice,
} from "@/lib/trip-params";
import { dateRange, peopleCount } from "@/lib/summary";

/** Дати для заголовка й історії: точні, або період вильоту з тривалістю. */
async function tripDates(query: TripQuery): Promise<string> {
  if (query.return_date) return dateRange(query.departure_date, query.return_date);
  const t = await getTranslations("tripResults");
  const nights = t("nights", { min: query.min_nights ?? 0, max: query.max_nights ?? 0 });
  return `${await dateRange(query.departure_date, query.departure_until)}, ${nights}`;
}
import { recordHistory, sessionToken } from "@/lib/session";
import { cn } from "@/lib/utils";

type Params = Promise<RawSearchParams>;

const EXAMPLES = [
  { from: "WAW", to: "LIS", depart: "2026-12-05", return: "2026-12-08" },
  { from: "KRK", to: "BCN", depart: "2026-12-10", return: "2026-12-14" },
] as const;

export default function TripPage({ searchParams }: PageProps<"/trip">) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <SiteHeader active="trip" />
      <main className="flex-1">
        <section className="relative isolate overflow-hidden border-b">
          <HeroBackdrop />
          <div className="mx-auto grid w-full max-w-6xl gap-5 px-4 py-5 sm:py-8">
            <Suspense fallback={null}>
              <HeroText searchParams={searchParams} />
            </Suspense>
            <Card className="border-primary/10 shadow-primary/[0.07] overflow-visible py-0 shadow-xl ring-0">
              <CardContent className="px-4 py-4 sm:px-6 sm:py-5">
                <Suspense fallback={<TripSearchForm initial={null} />}>
                  <SearchArea searchParams={searchParams} />
                </Suspense>
              </CardContent>
            </Card>
          </div>
        </section>

        <div className="mx-auto w-full max-w-6xl px-4 py-8">
          <SavedTripsProvider>
            <TripCompareProvider>
              <Suspense fallback={<ResultsSkeleton />}>
                <Results searchParams={searchParams} />
              </Suspense>
              <TripCompareBar />
            </TripCompareProvider>
          </SavedTripsProvider>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

async function HeroText({ searchParams }: { searchParams: Params }) {
  if (Object.keys(await searchParams).length > 0) return null;
  const t = await getTranslations("tripHome");
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
  const [status, raw] = await Promise.all([fetchAIStatus(), searchParams]);
  const query = parseTripParams(raw);
  const form = (
    <TripSearchForm
      key={query ? toTripParams(query).toString() : "empty"}
      initial={query ?? parseTripDraft(raw)}
      saved={savedId(raw)}
    />
  );
  const searchForm = query ? (
    <CollapsibleSearch
      title={`${query.origin} → ${query.destination}`}
      details={`${await tripDates(query)} · ${await peopleCount(query.adults ?? 2, query.children ?? 0)}`}
    >
      {form}
    </CollapsibleSearch>
  ) : (
    form
  );
  if (!status.enabled) return searchForm;
  return <SearchTabs form={searchForm} chat={<AIChat homeAirport={query?.origin} />} />;
}

async function Results({ searchParams }: { searchParams: Params }) {
  const raw = await searchParams;
  const query = parseTripParams(raw);
  const t = await getTranslations("tripResults");
  if (!query) {
    if (parseTripDraft(raw)?.stay) return <Notice>{t("pickOrigin")}</Notice>;
    return Object.keys(raw).length > 0 ? <Notice>{t("invalid")}</Notice> : <EmptyState />;
  }

  const result = await searchTrip(query);
  if (!result.ok) {
    return <Notice tone="error">{t(ERROR_KEY[result.reason])}</Notice>;
  }
  const data = result.data;
  const historyParams = toTripParams(query).toString();
  const historyTitle = `${query.origin} → ${query.destination} · ${await tripDates(query)}`;
  after(
    recordHistory(await sessionToken(), {
      kind: "trip",
      params: historyParams,
      title: historyTitle,
    }),
  );
  const offers = new Map(data.offers.map((o) => [`${o.source}:${o.id}`, o]));
  const combos = new Map(data.combos.map((c) => [c.key, c]));
  const flightsHref = `/?${toSearchParams({ query: data.flight_query, sort: "score" })}`;
  const staysHref = (combo: TripCombo) => {
    const stayQuery = data.stay_queries.find(
      (q) => q.check_in === combo.window.check_in && q.check_out === combo.window.check_out,
    ) as StayQuery;
    return `/stays?${toStayParams({ query: stayQuery, sort: "score" })}`;
  };
  const airlineNames = Object.fromEntries(data.airlines.map((a) => [a.code, a.name]));
  const travelers = t("travelers", { adults: query.adults ?? 2, children: query.children ?? 0 });
  const saved = savedId(raw);
  const pricedAt = new Date().toISOString();
  const tPicks = await getTranslations("tripPicks");
  const card = (combo: TripCombo, label?: TripSearchResult["picks"][number]) => (
    <TripCard
      combo={combo}
      offer={offers.get(combo.offer_key)!}
      stay={data.stays[combo.stay_index]}
      travelers={travelers}
      label={label?.label}
      also={label?.also ?? []}
      overBudget={label?.over_budget ?? false}
      airlineNames={airlineNames}
      flightsHref={flightsHref}
      staysHref={staysHref(combo)}
      chooseHref={
        combo.key === data.selected?.key
          ? undefined
          : withChoice(query, { flight: combo.offer_key, stay: combo.stay_key }, saved)
      }
      compare={
        <TripCompareToggle
          item={{
            key: combo.key,
            title: label ? tPicks(`label.${label.label}`) : historyTitle,
            snapshot: tripSnapshot(
              combo,
              offers.get(combo.offer_key)!,
              data.stays[combo.stay_index],
              pricedAt,
            ),
          }}
        />
      }
    />
  );
  const pickKeys = new Set(data.picks.map((p) => p.combo_key));
  const others = data.combos.filter((c) => !pickKeys.has(c.key));

  return (
    <div className="animate-in fade-in-0 grid gap-6 duration-300">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-0.5">
          <h2
            aria-label={t("title", { from: query.origin, to: query.destination })}
            className="flex items-center gap-2 text-2xl font-bold tracking-tight"
          >
            {query.origin}
            <Plane className="text-primary size-5" aria-hidden />
            {query.destination}
          </h2>
          <TripSummary query={query} combos={data.combos.length} flights={data.flights_found} />
        </div>
        <SaveSearch
          kind="trip"
          params={historyParams}
          title={historyTitle}
          back={`/trip?${historyParams}`}
        />
      </div>

      <ProviderAlerts providers={data.providers} />
      {data.pinned_stay && !query.flight && (
        <p
          className={cn(
            "rounded-lg px-3 py-2 text-xs",
            data.pinned_stay === "used"
              ? "bg-accent/60 text-accent-foreground"
              : "border border-amber-500/40 bg-amber-500/10",
          )}
          role="status"
          data-testid="trip-pinned"
        >
          {t(`pinned.${data.pinned_stay}`)}
        </p>
      )}
      <BudgetNote result={data} />

      {data.selected ? (
        <TripBuilder
          data={data}
          query={query}
          selected={data.selected}
          travelers={travelers}
          airlineNames={airlineNames}
          flightsHref={flightsHref}
          staysHref={staysHref(data.selected)}
          saved={saved}
          title={historyTitle}
          pricedAt={pricedAt}
        />
      ) : (
        <TripUndo params={historyParams} showButton={false} />
      )}

      {data.picks.length === 0 ? (
        <Notice>{data.flights_found > 0 ? t("noStays") : t("empty")}</Notice>
      ) : (
        <section className="grid gap-3" aria-labelledby="trip-picks-title">
          <div className="grid gap-1">
            <h2 id="trip-picks-title" className="text-xl font-semibold tracking-tight">
              {t("picksTitle")}
            </h2>
            <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {t("formula")}
            </p>
          </div>
          {data.picks.length < 3 && (
            <p className="text-muted-foreground text-xs" data-testid="trip-few-picks">
              {t("fewPicks", { count: data.picks.length })}
            </p>
          )}
          <ol className="grid gap-3 md:grid-cols-[repeat(auto-fill,minmax(18rem,1fr))]">
            {data.picks.map((pick) => (
              <li key={pick.combo_key}>{card(combos.get(pick.combo_key)!, pick)}</li>
            ))}
          </ol>
        </section>
      )}

      <p className="bg-accent/60 text-accent-foreground flex items-start gap-2 rounded-lg px-3 py-2 text-xs">
        <Info className="mt-px size-3.5 shrink-0" aria-hidden />
        {t("note")}
      </p>

      {others.length > 0 && (
        <section className="grid gap-3" aria-labelledby="trip-others-title">
          <h2 id="trip-others-title" className="text-lg font-semibold tracking-tight">
            {t("othersTitle", { count: others.length })}
          </h2>
          <ol className="grid gap-3 md:grid-cols-[repeat(auto-fill,minmax(18rem,1fr))]">
            {others.map((combo) => (
              <li key={combo.key}>{card(combo)}</li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function TripSummary({
  query,
  combos,
  flights,
}: {
  query: TripQuery;
  combos: number;
  flights: number;
}) {
  const t = useTranslations("tripResults");
  const format = useFormatter();
  const date = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  return (
    <p className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-sm">
      <CalendarDays className="size-3.5" aria-hidden />
      {query.return_date
        ? `${date(query.departure_date)} – ${date(query.return_date)}`
        : `${date(query.departure_date)}${query.departure_until ? ` – ${date(query.departure_until)}` : ""}, ${t("nights", { min: query.min_nights ?? 0, max: query.max_nights ?? 0 })}`}{" "}
      · {t("travelers", { adults: query.adults ?? 2, children: query.children ?? 0 })} ·{" "}
      {t("checked", { combos, flights })}
    </p>
  );
}

function BudgetNote({ result }: { result: TripSearchResult }) {
  const t = useTranslations("tripResults");
  const format = useFormatter();
  const budget = result.budget;
  if (!budget) return null;
  const money = (v: number) =>
    format.number(v, {
      style: "currency",
      currency: "EUR",
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: 0,
    });
  const over = budget.within === 0 && budget.shortfall != null;
  return (
    <p
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
        over
          ? "border-amber-500/40 bg-amber-500/10"
          : "border-emerald-500/40 bg-emerald-500/5 text-emerald-800 dark:text-emerald-300",
      )}
    >
      <Wallet className="mt-0.5 size-4 shrink-0" aria-hidden />
      {over
        ? t("overBudget", { budget: money(budget.budget), shortfall: money(budget.shortfall!) })
        : t("withinBudget", { budget: money(budget.budget), count: budget.within })}
    </p>
  );
}

const FEATURES = [
  { key: "total", icon: Wallet },
  { key: "dates", icon: CalendarDays },
  { key: "value", icon: Scale },
] as const;

function EmptyState() {
  const t = useTranslations("tripHome");
  return (
    <div className="grid gap-10 py-4">
      <div className="grid justify-items-center gap-3 text-center">
        <p className="text-muted-foreground">{t("emptyHint")}</p>
        <div className="flex flex-wrap items-center justify-center gap-2 text-sm">
          <span className="text-muted-foreground">{t("try")}</span>
          {EXAMPLES.map((example) => (
            <Link
              key={example.from + example.to}
              href={`/trip?${new URLSearchParams(example)}`}
              className="bg-card hover:border-primary/50 hover:text-primary flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 font-medium shadow-xs transition-all hover:-translate-y-px hover:shadow-sm"
            >
              <Luggage className="size-3.5" aria-hidden />
              {example.from} → {example.to}
            </Link>
          ))}
        </div>
      </div>
      <ul className="grid gap-3 sm:grid-cols-3">
        {FEATURES.map(({ key, icon: Icon }) => (
          <li key={key} className="bg-card lift grid gap-2 rounded-xl border p-5">
            <span className="bg-accent text-primary grid size-9 place-items-center rounded-lg">
              <Icon className="size-4.5" aria-hidden />
            </span>
            <p className="font-semibold">{t(`features.${key}.title`)}</p>
            <p className="text-muted-foreground text-sm">{t(`features.${key}.text`)}</p>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground flex items-center justify-center gap-1.5 text-xs">
        <Sparkles className="text-primary size-3.5" aria-hidden />
        {t("aiHint")}
      </p>
    </div>
  );
}

function Notice({
  children,
  tone = "info",
}: {
  children: React.ReactNode;
  tone?: "info" | "error";
}) {
  return (
    <p
      role="status"
      className={cn(
        "bg-card rounded-xl border px-4 py-8 text-center text-sm",
        tone === "error" ? "border-destructive/40 text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}

function ResultsSkeleton() {
  const t = useTranslations("tripResults");
  return (
    <div className="grid gap-4" aria-busy>
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Luggage className="text-primary size-4 animate-pulse" aria-hidden />
        {t("loading")}
      </p>
      <div className="grid gap-3 md:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="bg-card grid gap-3 rounded-xl border p-5">
            <div className="shimmer h-4 w-32 rounded" />
            <div className="shimmer h-8 w-24 rounded" />
            <div className="shimmer h-16 rounded" />
            <div className="shimmer h-10 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
