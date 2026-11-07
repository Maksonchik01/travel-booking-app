import type { Stay, StayPickLabel, StayScore } from "@tickets/shared";
import { BedDouble, CalendarDays, Info, MapPin, ShieldCheck, Sparkles, Star } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { after } from "next/server";
import { Suspense } from "react";

import { AIChat } from "@/components/ai-chat";
import { CollapsibleSearch } from "@/components/collapsible-search";
import { HeroBackdrop, SiteFooter } from "@/components/page-chrome";
import { LinkPendingOverlay } from "@/components/pending";
import { ProviderAlerts } from "@/components/provider-alerts";
import { SaveSearch } from "@/components/save-search";
import { SearchTabs } from "@/components/search-tabs";
import { ShowMore } from "@/components/show-more";
import { SiteHeader } from "@/components/site-header";
import { StayAnalysis } from "@/components/stay-analysis";
import { StayCard } from "@/components/stay-card";
import { StayFilters } from "@/components/stay-filters";
import { stayAnchor, StayPicks } from "@/components/stay-picks";
import { StaySearchForm } from "@/components/stay-search-form";
import { Card, CardContent } from "@/components/ui/card";
import { ERROR_KEY, fetchAIStatus, searchStays } from "@/lib/api";
import type { RawSearchParams } from "@/lib/search-params";
import {
  hasStayFilters,
  parseStayParams,
  STAY_SORT_KEYS,
  type StaySortKey,
  type StayState,
  toStayParams,
} from "@/lib/stay-params";
import { dateRange, peopleCount } from "@/lib/summary";
import { recordHistory, sessionToken } from "@/lib/session";
import { cn } from "@/lib/utils";

type Params = Promise<RawSearchParams>;

const EXAMPLES = [
  { city: "LIS", in: "2026-12-05", out: "2026-12-08" },
  { city: "BCN", in: "2026-12-10", out: "2026-12-14" },
  { city: "KRK", in: "2026-11-20", out: "2026-11-22" },
] as const;

export default function StaysPage({ searchParams }: PageProps<"/stays">) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <SiteHeader active="stays" />
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
                <Suspense fallback={<StaySearchForm initial={null} />}>
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

/** Заголовок — лише без пошуку: на сторінці результатів місце потрібне видачі. */
async function HeroText({ searchParams }: { searchParams: Params }) {
  if (Object.keys(await searchParams).length > 0) return null;
  const t = await getTranslations("staysHome");
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
  const state = parseStayParams(raw);
  const form = (
    <StaySearchForm key={state ? toStayParams(state).toString() : "empty"} initial={state} />
  );
  const searchForm = state ? (
    <CollapsibleSearch
      title={state.query.city}
      details={`${await dateRange(state.query.check_in, state.query.check_out)} · ${await peopleCount(state.query.guests?.adults ?? 2, state.query.guests?.children ?? 0)}`}
    >
      {form}
    </CollapsibleSearch>
  ) : (
    form
  );
  if (!status.enabled) return searchForm;
  return <SearchTabs form={searchForm} chat={<AIChat currentStaySearch={state?.query} />} />;
}

async function Results({ searchParams }: { searchParams: Params }) {
  const raw = await searchParams;
  const state = parseStayParams(raw);
  const t = await getTranslations("stayResults");

  if (!state) {
    const hasInput = Object.keys(raw).length > 0;
    return hasInput ? <Notice>{t("invalid")}</Notice> : <EmptyState />;
  }

  const [result, ai] = await Promise.all([searchStays(state.query), fetchAIStatus()]);
  if (!result.ok) {
    return <Notice tone="error">{t(ERROR_KEY[result.reason])}</Notice>;
  }

  const { query } = state;
  const { scoring, facets, place } = result.data;
  const historyParams = toStayParams(state).toString();
  const historyTitle = `${place?.name ?? query.city} · ${await dateRange(query.check_in, query.check_out)}`;
  after(
    recordHistory(await sessionToken(), {
      kind: "stays",
      params: historyParams,
      title: historyTitle,
    }),
  );
  const now = new Date();
  const scores = new Map<string, StayScore>(scoring.scores.map((s) => [s.stay_key, s]));
  const stays = sortStays(result.data.stays, state.sort, scores);
  const pickLabels = new Map<string, StayPickLabel>(
    scoring.picks.map((p) => [p.stay_key, p.label]),
  );
  const pickStays = scoring.picks
    .map((p) => result.data.stays.find((s) => `${s.source}:${s.id}` === p.stay_key))
    .filter((s): s is Stay => s !== undefined);
  const filtered = hasStayFilters(query.filters);
  const withoutFilters = toStayParams({
    ...state,
    query: { ...query, filters: { free_cancellation: false } },
  });

  return (
    <div className="animate-in fade-in-0 grid gap-6 duration-300">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-0.5">
          <h2 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <MapPin className="text-primary size-5" aria-hidden />
            {place?.name ?? query.city}
          </h2>
          <StaySummary
            state={state}
            count={stays.length}
            total={facets.total_stays}
            filtered={filtered}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SaveSearch
            kind="stays"
            params={historyParams}
            title={historyTitle}
            back={`/stays?${historyParams}`}
          />
          <SortToggle state={state} />
        </div>
      </div>

      <ProviderAlerts providers={result.data.providers} />

      <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start">
        {facets.total_stays > 0 && (
          <StayFilters
            key={toStayParams(state).toString()}
            filters={query.filters ?? {}}
            facets={facets}
            baseParams={[...withoutFilters]}
          />
        )}

        <div className="grid gap-6 lg:col-start-2">
          <StayPicks scoring={scoring} stays={result.data.stays}>
            {ai.enabled && pickStays.length > 0 && (
              <StayAnalysis key={toStayParams(state).toString()} query={query} stays={pickStays} />
            )}
          </StayPicks>

          <p className="bg-accent/60 text-accent-foreground flex items-start gap-2 rounded-lg px-3 py-2 text-xs">
            <Info className="mt-px size-3.5 shrink-0" aria-hidden />
            {t("note")}
          </p>

          {stays.length === 0 ? (
            filtered && facets.total_stays > 0 ? (
              <Notice>
                {t("filteredEmpty", { total: facets.total_stays })}{" "}
                <Link
                  href={`/stays?${withoutFilters}`}
                  className="text-primary font-medium underline"
                >
                  {t("resetFilters")}
                </Link>
              </Notice>
            ) : (
              <Notice>{t("empty")}</Notice>
            )
          ) : (
            <ShowMore
              items={stays.map((stay) => {
                const key = `${stay.source}:${stay.id}`;
                return {
                  key: stayAnchor(key),
                  node: (
                    <StayCard
                      stay={stay}
                      now={now}
                      pickLabel={pickLabels.get(key)}
                      score={scores.get(key)}
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

function StaySummary({
  state,
  count,
  total,
  filtered,
}: {
  state: StayState;
  count: number;
  total: number;
  filtered: boolean;
}) {
  const t = useTranslations("stayResults");
  const format = useFormatter();
  const { query } = state;
  const date = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  const nights = Math.round(
    (Date.parse(`${query.check_out}T00:00:00Z`) - Date.parse(`${query.check_in}T00:00:00Z`)) /
      86_400_000,
  );
  return (
    <p className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-sm">
      <CalendarDays className="size-3.5" aria-hidden />
      {date(query.check_in)} – {date(query.check_out)} · {t("nights", { count: nights })} ·{" "}
      {t("guests", { count: (query.guests?.adults ?? 2) + (query.guests?.children ?? 0) })} ·{" "}
      {filtered ? t("countFiltered", { count, total }) : t("count", { count })}
    </p>
  );
}

function sortStays(stays: Stay[], sort: StaySortKey, scores: Map<string, StayScore>): Stay[] {
  if (sort === "price") return stays;
  const score = (s: Stay) => scores.get(`${s.source}:${s.id}`);
  if (sort === "score") {
    const total = (s: Stay) => score(s)?.breakdown.total ?? Number.POSITIVE_INFINITY;
    return [...stays].sort((a, b) => total(a) - total(b) || a.price_per_night - b.price_per_night);
  }
  // Рейтинг — скоригований на кількість відгуків, як у скорингу.
  const rating = (s: Stay) => score(s)?.breakdown.adjusted_rating ?? -1;
  return [...stays].sort((a, b) => rating(b) - rating(a) || a.price_per_night - b.price_per_night);
}

function SortToggle({ state }: { state: StayState }) {
  const t = useTranslations("stayResults");
  const tShared = useTranslations("results");
  const labels: Record<StaySortKey, string> = {
    price: t("sortPrice"),
    rating: t("sortRating"),
    score: t("sortScore"),
  };
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground hidden sm:inline">{tShared("sortBy")}</span>
      <div className="bg-muted inline-flex rounded-lg p-1">
        {STAY_SORT_KEYS.map((key) => (
          <Link
            key={key}
            href={`/stays?${toStayParams({ ...state, sort: key })}`}
            aria-current={state.sort === key ? "true" : undefined}
            className={cn(
              "relative rounded-md px-3 py-1.5 transition-all",
              state.sort === key
                ? "bg-card text-primary font-medium shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-card/50",
            )}
          >
            {labels[key]}
            <LinkPendingOverlay />
          </Link>
        ))}
      </div>
    </div>
  );
}

const FEATURES = [
  { key: "value", icon: Star },
  { key: "cancellation", icon: ShieldCheck },
  { key: "ai", icon: Sparkles },
] as const;

function EmptyState() {
  const t = useTranslations("staysHome");
  const tCity = useTranslations("staysHome.examples");
  return (
    <div className="grid gap-10 py-4">
      <div className="grid justify-items-center gap-3 text-center">
        <p className="text-muted-foreground">{t("emptyHint")}</p>
        <div className="flex flex-wrap items-center justify-center gap-2 text-sm">
          <span className="text-muted-foreground">{t("try")}</span>
          {EXAMPLES.map((example) => (
            <Link
              key={example.city}
              href={`/stays?${new URLSearchParams(example)}`}
              className="bg-card hover:border-primary/50 hover:text-primary flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 font-medium shadow-xs transition-all hover:-translate-y-px hover:shadow-sm"
            >
              <BedDouble className="size-3.5" aria-hidden />
              {tCity(example.city)}
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
  const t = useTranslations("stayResults");
  return (
    <div className="grid gap-4" aria-busy>
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <BedDouble className="text-primary size-4 animate-pulse" aria-hidden />
        {t("loading")}
      </p>
      <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <div className="shimmer hidden h-72 rounded-xl lg:block" />
        <div className="grid gap-3">
          {Array.from({ length: 3 }, (_, i) => (
            <div
              key={i}
              className="bg-card grid gap-3 rounded-xl border p-5 sm:grid-cols-[9rem_1fr_13rem]"
            >
              <div className="shimmer hidden h-24 rounded-lg sm:block" />
              <div className="grid gap-3">
                <div className="shimmer h-3 w-32 rounded" />
                <div className="shimmer h-5 w-2/3 rounded" />
                <div className="shimmer h-3 w-1/2 rounded" />
              </div>
              <div className="shimmer h-24 rounded-lg" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
