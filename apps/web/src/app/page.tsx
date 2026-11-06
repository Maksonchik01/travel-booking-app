import type { Offer, OfferScore, PickLabel } from "@tickets/shared";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { AIExplanation } from "@/components/ai-explanation";
import { AIChat } from "@/components/ai-chat";
import { OfferCard } from "@/components/offer-card";
import { LinkPendingOverlay } from "@/components/pending";
import { PriceCalendar } from "@/components/price-calendar";
import { ProviderAlerts } from "@/components/provider-alerts";
import { ResultFilters } from "@/components/result-filters";
import { SearchForm } from "@/components/search-form";
import { ServiceStatus } from "@/components/service-status";
import { SiteHeader } from "@/components/site-header";
import { offerAnchor, TopPicks } from "@/components/top-picks";
import { Card, CardContent } from "@/components/ui/card";
import {
  explainSearch,
  fetchAIStatus,
  fetchCalendar,
  fetchReadiness,
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
import { cn } from "@/lib/utils";

type Params = Promise<RawSearchParams>;

const EXAMPLES = [
  { from: "WAW", to: "LIS", depart: "2026-12-05", return: "2026-12-12", flex: "2" },
  { from: "WAW", to: "BCN", depart: "2026-12-10", flex: "3" },
  { from: "KRK", to: "LON", depart: "2026-11-20" },
] as const;

export default function HomePage({ searchParams }: PageProps<"/">) {
  const t = useTranslations("home");
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <SiteHeader />
      <main className="flex-1">
        <section className="from-primary/5 border-b bg-gradient-to-b to-transparent">
          <div className="mx-auto grid w-full max-w-5xl gap-6 px-4 pt-10 pb-8">
            <div className="grid gap-2">
              <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
                {t("title")}
              </h1>
              <p className="text-muted-foreground max-w-2xl text-balance">{t("subtitle")}</p>
            </div>
            {/* overflow-visible: список підказок міст не обрізається краєм картки */}
            <Card className="overflow-visible shadow-sm">
              <CardContent className="grid gap-5">
                <Suspense fallback={null}>
                  <AIChatIfEnabled searchParams={searchParams} />
                </Suspense>
                <Suspense fallback={<SearchForm initial={null} />}>
                  <SearchFormFromUrl searchParams={searchParams} />
                </Suspense>
              </CardContent>
            </Card>
          </div>
        </section>

        <div className="mx-auto w-full max-w-5xl px-4 py-8">
          <Suspense fallback={<ResultsSkeleton />}>
            <Results searchParams={searchParams} />
          </Suspense>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

async function SearchFormFromUrl({ searchParams }: { searchParams: Params }) {
  const state = parseSearchParams(await searchParams);
  // key: при новому пошуку форма скидається до значень з URL.
  return <SearchForm key={state ? toSearchParams(state).toString() : "empty"} initial={state} />;
}

/** Розмова з ШІ-агентом — лише коли на бекенді увімкнено LLM (LLM_PROVIDER). */
async function AIChatIfEnabled({ searchParams }: { searchParams: Params }) {
  const [status, raw] = await Promise.all([fetchAIStatus(), searchParams]);
  if (!status.enabled) return null;
  const current = parseSearchParams(raw)?.query;
  return (
    <>
      <AIChat currentSearch={current} homeAirport={current?.origin} />
      <div className="text-muted-foreground flex items-center gap-3 text-xs">
        <span className="bg-border h-px flex-1" />
        {(await getTranslations("ai"))("orForm")}
        <span className="bg-border h-px flex-1" />
      </div>
    </>
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
    <div className="bg-primary/5 text-muted-foreground animate-pulse rounded-xl border p-4 text-sm">
      {t("explaining")}
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
  const [result, calendar] = await Promise.all([
    searchFlights(query),
    fetchCalendar(query.origin, query.destination, month, query.currency ?? "EUR"),
  ]);
  const now = new Date();

  if (!result.ok) {
    return (
      <Notice tone="error">{t(result.reason === "unreachable" ? "unreachable" : "error")}</Notice>
    );
  }

  const { scoring, facets } = result.data;
  const scores = new Map<string, OfferScore>(scoring.scores.map((s) => [s.offer_key, s]));
  const offers = sortOffers(result.data.offers, state.sort, scores);
  const pickLabels = new Map<string, PickLabel>(scoring.picks.map((p) => [p.offer_key, p.label]));
  const airlineNames = Object.fromEntries(facets.airlines.map((a) => [a.code, a.name]));
  const filtered = hasFilters(query.filters);
  const withoutFilters = toSearchParams({ ...state, query: { ...query, filters: {} } });
  return (
    <div className="grid gap-6">
      {calendar.ok && calendar.data.days.length > 0 ? (
        <PriceCalendar month={month} days={calendar.data.days} state={state} />
      ) : (
        !calendar.ok && (
          <p className="text-muted-foreground text-sm">
            {(await getTranslations("calendar"))("unavailable")}
          </p>
        )
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            {t("title", { from: query.origin, to: query.destination })}
          </h2>
          <p className="text-muted-foreground text-sm">
            {filtered
              ? t("countFiltered", { count: offers.length, total: facets.total_offers })
              : t("count", { count: offers.length })}
            {query.origin_radius_km || query.destination_radius_km ? ` · ${t("withNearby")}` : null}
          </p>
        </div>
        <SortToggle state={state} />
      </div>

      <ProviderAlerts providers={result.data.providers} />

      <div className="grid gap-6 lg:grid-cols-[14rem_minmax(0,1fr)] lg:items-start">
        {facets.total_offers > 0 && (
          <ResultFilters
            key={toSearchParams(state).toString()}
            filters={query.filters ?? {}}
            airlines={facets.airlines}
            baseParams={[...withoutFilters]}
          />
        )}

        <div className="grid gap-6 lg:col-start-2">
          {offers.length > 0 && (
            <Suspense key={toSearchParams(state).toString()} fallback={<ExplanationSkeleton />}>
              <ExplanationIfEnabled state={state} />
            </Suspense>
          )}

          <TopPicks scoring={scoring} offers={result.data.offers} />

          <p className="bg-muted/50 text-muted-foreground rounded-md px-3 py-2 text-xs">
            {offers.length > 0 && offers.every(isLivePrice) ? t("liveNote") : t("cachedNote")}
          </p>

          {offers.length === 0 ? (
            filtered && facets.total_offers > 0 ? (
              <Notice>
                {t("filteredEmpty", { total: facets.total_offers })}{" "}
                <Link href={`/?${withoutFilters}`} className="underline">
                  {t("resetFilters")}
                </Link>
              </Notice>
            ) : (
              <Notice>{t("empty")}</Notice>
            )
          ) : (
            <ol className="grid gap-3">
              {offers.map((offer) => {
                const key = `${offer.source}:${offer.id}`;
                return (
                  <li
                    key={`${offer.source}-${offer.id}`}
                    id={offerAnchor(key)}
                    className="scroll-mt-4"
                  >
                    <OfferCard
                      offer={offer}
                      now={now}
                      pickLabel={pickLabels.get(key)}
                      score={scores.get(key)}
                      airlineNames={airlineNames}
                    />
                  </li>
                );
              })}
            </ol>
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
      <span className="text-muted-foreground">{t("sortBy")}</span>
      <div className="bg-muted inline-flex rounded-md p-0.5">
        {options.map(({ key, label }) => (
          <Link
            key={key}
            href={`/?${toSearchParams({ ...state, sort: key })}`}
            aria-current={state.sort === key ? "true" : undefined}
            className={cn(
              "relative rounded px-3 py-1 transition-colors",
              state.sort === key ? "bg-background shadow-xs font-medium" : "text-muted-foreground",
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

function EmptyState() {
  const t = useTranslations("home");
  return (
    <div className="grid justify-items-center gap-3 py-10 text-center">
      <p className="text-muted-foreground">{t("emptyHint")}</p>
      <div className="flex flex-wrap items-center justify-center gap-2 text-sm">
        <span className="text-muted-foreground">{t("examples")}</span>
        {EXAMPLES.map((example) => (
          <Link
            key={example.from + example.to}
            href={`/?${new URLSearchParams(example)}`}
            className="hover:bg-muted rounded-full border px-3 py-1 font-medium"
          >
            {example.from} → {example.to}
          </Link>
        ))}
      </div>
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
        "rounded-md border px-4 py-6 text-center text-sm",
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
    <div className="grid gap-3" aria-busy>
      <p className="text-muted-foreground text-sm">{t("loading")}</p>
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="bg-muted h-36 animate-pulse rounded-xl" />
      ))}
    </div>
  );
}

function SiteFooter() {
  const t = useTranslations("footer");
  return (
    <footer className="border-t">
      <div className="text-muted-foreground mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-4 px-4 py-6 text-xs">
        <p>{t("disclaimer")}</p>
        <Suspense fallback={null}>
          <FooterStatus />
        </Suspense>
      </div>
    </footer>
  );
}

async function FooterStatus() {
  return <ServiceStatus status={await fetchReadiness()} compact />;
}
