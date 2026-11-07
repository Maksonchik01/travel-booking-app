import type { Offer, OfferScore, PickLabel } from "@tickets/shared";
import { Info, Plane, ShieldCheck, Sparkles, Wallet } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { after } from "next/server";
import { Suspense } from "react";

import { AIChat } from "@/components/ai-chat";
import { AIExplanation } from "@/components/ai-explanation";
import { CollapsibleSearch } from "@/components/collapsible-search";
import { OfferCard } from "@/components/offer-card";
import { HeroBackdrop, SiteFooter } from "@/components/page-chrome";
import { LinkPendingOverlay } from "@/components/pending";
import { PriceAlert } from "@/components/price-alert";
import { PriceCalendar } from "@/components/price-calendar";
import { ProviderAlerts } from "@/components/provider-alerts";
import { ResultFilters } from "@/components/result-filters";
import { SaveSearch } from "@/components/save-search";
import { SearchForm } from "@/components/search-form";
import { SearchTabs } from "@/components/search-tabs";
import { ShowMore } from "@/components/show-more";
import { SiteHeader } from "@/components/site-header";
import { offerAnchor, TopPicks } from "@/components/top-picks";
import { Card, CardContent } from "@/components/ui/card";
import {
  ERROR_KEY,
  explainSearch,
  fetchAIStatus,
  fetchAlertChannels,
  fetchCalendar,
  searchFlights,
} from "@/lib/api";
import {
  hasFilters,
  parseSearchParams,
  type RawSearchParams,
  type SearchState,
  SORT_KEYS,
  type SortKey,
  toSearchParams,
} from "@/lib/search-params";
import { dateRange, peopleCount } from "@/lib/summary";
import { recordHistory, sessionToken } from "@/lib/session";
import { cn } from "@/lib/utils";

type Params = Promise<RawSearchParams>;

const EXAMPLES = [
  { from: "WAW", to: "LIS", depart: "2026-12-05", return: "2026-12-12", flex: "2" },
  { from: "WAW", to: "BCN", depart: "2026-12-10", flex: "3" },
  { from: "KRK", to: "LON", depart: "2026-11-20" },
] as const;

export default function HomePage({ searchParams }: PageProps<"/">) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <SiteHeader active="flights" />
      <main className="flex-1">
        <section className="relative isolate overflow-hidden border-b">
          <HeroBackdrop />
          <div className="mx-auto grid w-full max-w-6xl gap-5 px-4 py-5 sm:py-8">
            <Suspense fallback={null}>
              <HeroText searchParams={searchParams} />
            </Suspense>
            {/* overflow-visible: список підказок міст не обрізається краєм картки */}
            <Card className="border-primary/10 shadow-primary/[0.07] overflow-visible py-0 shadow-xl ring-0">
              <CardContent className="px-4 py-4 sm:px-6 sm:py-5">
                <Suspense fallback={<SearchForm initial={null} />}>
                  <SearchArea searchParams={searchParams} />
                </Suspense>
              </CardContent>
            </Card>
          </div>
        </section>

        <div className="mx-auto w-full max-w-6xl px-4 py-8">
          <Suspense fallback={<ResultsSkeleton />}>
            <Results searchParams={searchParams} />
          </Suspense>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

/** Заголовок — лише на головній: на сторінці результатів місце потрібне видачі. */
async function HeroText({ searchParams }: { searchParams: Params }) {
  if (Object.keys(await searchParams).length > 0) return null;
  const t = await getTranslations("home");
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

/** Форма і (коли увімкнено LLM) ШІ-помічник — у вкладках однієї картки. */
async function SearchArea({ searchParams }: { searchParams: Params }) {
  const [status, raw] = await Promise.all([fetchAIStatus(), searchParams]);
  const state = parseSearchParams(raw);
  // key: при новому пошуку форма скидається до значень з URL.
  const form = (
    <SearchForm key={state ? toSearchParams(state).toString() : "empty"} initial={state} />
  );
  // На мобільному на сторінці результатів форма згортається в рядок «що шукаємо».
  const searchForm = state ? (
    <CollapsibleSearch
      title={`${state.query.origin} → ${state.query.destination}`}
      details={`${await dateRange(state.query.departure_date, state.query.return_date)} · ${await peopleCount(state.query.passengers?.adults ?? 1)}`}
    >
      {form}
    </CollapsibleSearch>
  ) : (
    form
  );
  if (!status.enabled) return searchForm;
  return (
    <SearchTabs
      form={searchForm}
      chat={<AIChat currentSearch={state?.query} homeAirport={state?.query.origin} />}
    />
  );
}

/** Пояснення ШІ вантажиться окремо: результати не чекають на модель. */
async function ExplanationIfEnabled({ state }: { state: SearchState }) {
  const status = await fetchAIStatus();
  if (!status.enabled) return null;
  const result = await explainSearch(state.query);
  return result.ok ? <AIExplanation result={result.data} /> : null;
}

function ExplanationSkeleton() {
  const t = useTranslations("ai");
  return (
    <div className="border-primary/20 bg-primary/[0.04] grid gap-3 rounded-xl border p-4">
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Sparkles className="text-primary size-4 animate-pulse" aria-hidden />
        {t("explaining")}
      </p>
      <div className="shimmer h-3 w-3/4 rounded" />
      <div className="shimmer h-3 w-1/2 rounded" />
    </div>
  );
}

async function Results({ searchParams }: { searchParams: Params }) {
  const raw = await searchParams;
  const state = parseSearchParams(raw);
  const t = await getTranslations("results");

  if (!state) {
    const hasInput = Object.keys(raw).length > 0;
    return hasInput ? (
      <Notice>{(await getTranslations("search"))("invalid")}</Notice>
    ) : (
      <EmptyState />
    );
  }

  const { query } = state;
  const month = query.departure_date.slice(0, 7);
  const [result, calendar, alertChannels] = await Promise.all([
    searchFlights(query),
    fetchCalendar(query.origin, query.destination, month, query.currency ?? "EUR"),
    fetchAlertChannels(),
  ]);
  const now = new Date();

  if (!result.ok) {
    return <Notice tone="error">{t(ERROR_KEY[result.reason])}</Notice>;
  }

  // Історія кабінету (лише для тих, хто увійшов) — після відповіді, без затримки сторінки.
  const historyParams = toSearchParams(state).toString();
  const historyTitle = `${query.origin} → ${query.destination} · ${await dateRange(query.departure_date, query.return_date)}`;
  after(
    recordHistory(await sessionToken(), {
      kind: "flights",
      params: historyParams,
      title: historyTitle,
    }),
  );

  const { scoring, facets } = result.data;
  const scores = new Map<string, OfferScore>(scoring.scores.map((s) => [s.offer_key, s]));
  const offers = sortOffers(result.data.offers, state.sort, scores);
  const pickLabels = new Map<string, PickLabel>(scoring.picks.map((p) => [p.offer_key, p.label]));
  const airlineNames = Object.fromEntries(facets.airlines.map((a) => [a.code, a.name]));
  const filtered = hasFilters(query.filters);
  const withoutFilters = toSearchParams({ ...state, query: { ...query, filters: {} } });
  return (
    <div className="animate-in fade-in-0 grid gap-6 duration-300">
      {/* 1. Що шукали й скільки знайшли — і як упорядкувати. */}
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
          <p className="text-muted-foreground text-sm">
            {filtered
              ? t("countFiltered", { count: offers.length, total: facets.total_offers })
              : t("count", { count: offers.length })}
            {query.origin_radius_km || query.destination_radius_km ? ` · ${t("withNearby")}` : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SaveSearch
            kind="flights"
            params={historyParams}
            title={historyTitle}
            back={`/?${historyParams}`}
          />
          <SortToggle state={state} />
        </div>
      </div>

      {/* Підписка на ціну маршруту (етап 7): поріг пропонуємо від найкращої ціни. */}
      {alertChannels && (
        <PriceAlert
          query={query}
          bestPrice={result.data.offers[0]?.price ?? null}
          channels={alertChannels}
        />
      )}

      {/* 2. Проблеми з джерелами — до результатів, щоб було ясно, чому їх мало. */}
      <ProviderAlerts providers={result.data.providers} />

      {/* 3. Сусідні дати — підказка, коли дешевше. */}
      {calendar.ok && calendar.data.days.length > 0 ? (
        <PriceCalendar month={month} days={calendar.data.days} state={state} />
      ) : (
        !calendar.ok && (
          <p className="text-muted-foreground text-sm">
            {(await getTranslations("calendar"))("unavailable")}
          </p>
        )
      )}

      {/* 4. Фільтри збоку, справа — вибір, пояснення і весь список. */}
      <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start">
        {facets.total_offers > 0 && (
          <ResultFilters
            key={toSearchParams(state).toString()}
            filters={query.filters ?? {}}
            airlines={facets.airlines}
            baseParams={[...withoutFilters]}
          />
        )}

        <div className="grid gap-6 lg:col-start-2">
          <TopPicks scoring={scoring} offers={result.data.offers} />

          {offers.length > 0 && (
            <Suspense key={toSearchParams(state).toString()} fallback={<ExplanationSkeleton />}>
              <ExplanationIfEnabled state={state} />
            </Suspense>
          )}

          <p className="bg-accent/60 text-accent-foreground flex items-start gap-2 rounded-lg px-3 py-2 text-xs">
            <Info className="mt-px size-3.5 shrink-0" aria-hidden />
            {offers.length > 0 && offers.every(isLivePrice) ? t("liveNote") : t("cachedNote")}
          </p>

          {offers.length === 0 ? (
            filtered && facets.total_offers > 0 ? (
              <Notice>
                {t("filteredEmpty", { total: facets.total_offers })}{" "}
                <Link href={`/?${withoutFilters}`} className="text-primary font-medium underline">
                  {t("resetFilters")}
                </Link>
              </Notice>
            ) : (
              <Notice>{t("empty")}</Notice>
            )
          ) : (
            <ShowMore
              items={offers.map((offer) => {
                const key = `${offer.source}:${offer.id}`;
                return {
                  key: offerAnchor(key),
                  node: (
                    <OfferCard
                      offer={offer}
                      now={now}
                      pickLabel={pickLabels.get(key)}
                      score={scores.get(key)}
                      airlineNames={airlineNames}
                    />
                  ),
                };
              })}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** Живий пошук: провайдер зафіксував ціну в момент нашого запиту. */
function isLivePrice(offer: Offer): boolean {
  return offer.found_at != null && offer.found_at === offer.collected_at;
}

function sortOffers(offers: Offer[], sort: SortKey, scores: Map<string, OfferScore>): Offer[] {
  if (sort === "price") return offers;
  if (sort === "score") {
    // Неоцінені (невідома тривалість, інша валюта) — в кінець, між собою за ціною.
    const total = (o: Offer) =>
      scores.get(`${o.source}:${o.id}`)?.breakdown.total ?? Number.POSITIVE_INFINITY;
    return [...offers].sort((a, b) => total(a) - total(b) || a.price - b.price);
  }
  // Невідома тривалість — в кінець, щоб не вдавати, що варіант швидкий.
  return [...offers].sort(
    (a, b) =>
      (a.total_duration_min ?? Number.POSITIVE_INFINITY) -
        (b.total_duration_min ?? Number.POSITIVE_INFINITY) || a.price - b.price,
  );
}

function SortToggle({ state }: { state: SearchState }) {
  const t = useTranslations("results");
  const labels: Record<SortKey, string> = {
    price: t("sortPrice"),
    duration: t("sortDuration"),
    score: t("sortScore"),
  };
  const options = SORT_KEYS.map((key) => ({ key, label: labels[key] }));
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground hidden sm:inline">{t("sortBy")}</span>
      <div className="bg-muted inline-flex rounded-lg p-1">
        {options.map(({ key, label }) => (
          <Link
            key={key}
            href={`/?${toSearchParams({ ...state, sort: key })}`}
            aria-current={state.sort === key ? "true" : undefined}
            className={cn(
              "relative rounded-md px-3 py-1.5 transition-all",
              state.sort === key
                ? "bg-card text-primary font-medium shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-card/50",
            )}
          >
            {label}
            <LinkPendingOverlay />
          </Link>
        ))}
      </div>
    </div>
  );
}

const FEATURES = [
  { key: "price", icon: Wallet },
  { key: "risks", icon: ShieldCheck },
  { key: "ai", icon: Sparkles },
] as const;

function EmptyState() {
  const t = useTranslations("home");
  return (
    <div className="grid gap-10 py-4">
      <div className="grid justify-items-center gap-3 text-center">
        <p className="text-muted-foreground">{t("emptyHint")}</p>
        <div className="flex flex-wrap items-center justify-center gap-2 text-sm">
          <span className="text-muted-foreground">{t("examples")}</span>
          {EXAMPLES.map((example) => (
            <Link
              key={example.from + example.to}
              href={`/?${new URLSearchParams(example)}`}
              className="bg-card hover:border-primary/50 hover:text-primary flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 font-medium shadow-xs transition-all hover:-translate-y-px hover:shadow-sm"
            >
              {example.from}
              <Plane className="size-3.5" aria-hidden />
              {example.to}
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
  const t = useTranslations("results");
  return (
    <div className="grid gap-4" aria-busy>
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Plane className="text-primary size-4 animate-pulse" aria-hidden />
        {t("loading")}
      </p>
      <div className="shimmer h-24 rounded-xl" />
      <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <div className="shimmer hidden h-72 rounded-xl lg:block" />
        <div className="grid gap-3">
          {Array.from({ length: 3 }, (_, i) => (
            <div
              key={i}
              className="bg-card grid gap-3 rounded-xl border p-5 sm:grid-cols-[1fr_13rem]"
            >
              <div className="grid gap-3">
                <div className="shimmer h-3 w-40 rounded" />
                <div className="shimmer h-8 rounded" />
                <div className="shimmer h-3 w-24 rounded" />
              </div>
              <div className="shimmer h-24 rounded-lg" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
