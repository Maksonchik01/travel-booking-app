import type { Stay, StayPickLabel, StayQuery, StayScore } from "@tickets/shared";
import {
  BedDouble,
  CalendarDays,
  Info,
  List,
  Map as MapIcon,
  MapPin,
  ShieldCheck,
  Sparkles,
  Star,
} from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { after } from "next/server";
import { Suspense } from "react";

import { AIChat } from "@/components/ai-chat";
import { CollapsibleSearch } from "@/components/collapsible-search";
import { FavoritesProvider } from "@/components/favorites";
import { HeroBackdrop, SiteFooter } from "@/components/page-chrome";
import { LinkPendingOverlay } from "@/components/pending";
import { ProviderAlerts } from "@/components/provider-alerts";
import { PriceAlert } from "@/components/price-alert";
import { stayTarget } from "@/lib/alerts";
import { SaveSearch } from "@/components/save-search";
import { ShareLink } from "@/components/share-link";
import { RecentSearches, RememberSearch } from "@/components/recent-searches";
import { PageNotice } from "@/components/page-notice";
import { EmptySuggestions } from "@/components/empty-suggestions";
import { staySuggestions } from "@/lib/empty-suggestions";
import { SearchModes } from "@/components/search-modes";
import { SearchTabs } from "@/components/search-tabs";
import { ShowMore } from "@/components/show-more";
import { SiteHeader } from "@/components/site-header";
import { StayAnalysis } from "@/components/stay-analysis";
import { StayCard } from "@/components/stay-card";
import { StayFilters } from "@/components/stay-filters";
import type { MapStay } from "@/components/stay-map";
import { StayMapLazy } from "@/components/stay-map-lazy";
import { StayMapList } from "@/components/stay-map-list";
import { stayAnchor, StayPicks } from "@/components/stay-picks";
import { StaySearchForm } from "@/components/stay-search-form";
import { Card, CardContent } from "@/components/ui/card";
import { ERROR_KEY, fetchAIStatus, fetchAlertChannels, searchStays } from "@/lib/api";
import type { RawSearchParams } from "@/lib/search-params";
import {
  hasStayFilters,
  parseStayParams,
  STAY_SORT_KEYS,
  stayHotelHref,
  type StaySortKey,
  type StayState,
  toStayParams,
} from "@/lib/stay-params";
import { dateRange, peopleCount } from "@/lib/summary";
import { stayPreferences, stayPrefParams } from "@/lib/search-prefs";
import { currentAccount, recordHistory, sessionToken } from "@/lib/session";
import { commonFrom, isDraft } from "@/lib/search-modes";
import { searchEvents } from "@/lib/server-analytics";
import { sortStays } from "@/lib/sort";
import { cn } from "@/lib/utils";
import { CollapsedSearchSkeleton, ShellChoice } from "@/components/search-shell";
import { HeroTitle } from "@/components/hero-title";

type Params = Promise<RawSearchParams>;

const EXAMPLES = [
  { city: "LIS", in: "2026-12-05", out: "2026-12-08" },
  { city: "BCN", in: "2026-12-10", out: "2026-12-14" },
  { city: "KRK", in: "2026-11-20", out: "2026-11-22" },
] as const;

export default function StaysPage({ searchParams }: PageProps<"/[locale]/stays">) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <SiteHeader active="stays" />
      <main id="main" tabIndex={-1} className="outline-none flex-1">
        <section className="relative isolate overflow-hidden border-b">
          <HeroBackdrop />
          <div className="mx-auto grid w-full max-w-6xl gap-5 px-4 py-5 sm:py-8">
            <Suspense fallback={<ShellChoice start={<Hero />} results={null} />}>
              <HeroText searchParams={searchParams} />
            </Suspense>
            {/* overflow-visible: список підказок міст не обрізається краєм картки */}
            <Card className="border-primary/10 shadow-primary/[0.07] overflow-visible py-0 shadow-xl ring-0">
              <CardContent className="px-4 py-4 sm:px-6 sm:py-5">
                <Suspense
                  fallback={
                    <ShellChoice
                      start={<StaySearchForm initial={null} />}
                      results={<CollapsedSearchSkeleton />}
                    />
                  }
                >
                  <SearchArea searchParams={searchParams} />
                </Suspense>
              </CardContent>
            </Card>
          </div>
        </section>

        <div className="mx-auto w-full max-w-6xl px-4 py-8">
          <FavoritesProvider>
            <Suspense fallback={<ResultsSkeleton />}>
              <Results searchParams={searchParams} />
            </Suspense>
          </FavoritesProvider>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

/** Заголовок — лише без пошуку: на сторінці результатів місце потрібне видачі. */
/** Заголовок старту: синхронний — однаковий в оболонці й після завантаження (етап 9 V3). */
function Hero() {
  return <HeroTitle namespace="staysHome" />;
}

async function HeroText({ searchParams }: { searchParams: Params }) {
  const t = await getTranslations("staysHome");
  const raw = await searchParams;
  // Над результатами видимого заголовка немає — h1 лише для screen reader і структури.
  if (!isDraft(raw) && parseStayParams(raw)) {
    return <h1 className="sr-only">{t("resultsHeading")}</h1>;
  }
  return <Hero />;
}

async function SearchArea({ searchParams }: { searchParams: Params }) {
  const [status, raw, account] = await Promise.all([
    fetchAIStatus(),
    searchParams,
    currentAccount(),
  ]);
  const state = isDraft(raw) ? null : parseStayParams(raw);
  const form = (
    <StaySearchForm
      key={state ? toStayParams(state).toString() : "empty"}
      initial={state}
      carried={state ? null : commonFrom("stays", raw)}
      prefs={
        account
          ? {
              filters: stayPrefParams(account.search_prefs),
              profile: account.search_prefs?.stays?.profile,
              currency: account.currency,
            }
          : null
      }
    />
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
  const withModes = (inner: React.ReactNode) => (
    <SearchModes
      current="stays"
      common={commonFrom("stays", raw)}
      drafting={!state}
      ai={status.enabled}
    >
      {inner}
    </SearchModes>
  );
  if (!status.enabled) return withModes(searchForm);
  return withModes(
    <SearchTabs form={searchForm} chat={<AIChat currentStaySearch={state?.query} />} />,
  );
}

async function Results({ searchParams }: { searchParams: Params }) {
  const raw = await searchParams;
  const state = isDraft(raw) ? null : parseStayParams(raw);
  const t = await getTranslations("stayResults");

  if (!state) {
    const hasInput = Object.keys(raw).length > 0 && !isDraft(raw);
    return hasInput ? <PageNotice>{t("invalid")}</PageNotice> : <EmptyState />;
  }

  // Бажані зручності з профілю — м'яко, лише в оцінку (модуль 14.3).
  const preferences = stayPreferences((await currentAccount())?.search_prefs);
  const [result, ai, alertChannels] = await Promise.all([
    searchStays(preferences ? { ...state.query, preferences } : state.query),
    fetchAIStatus(),
    fetchAlertChannels(),
  ]);
  // Аналітика пошуку (модуль 19): анонімно — режим і результат, без маршруту чи дат.
  after(
    await searchEvents(
      "stays",
      result.ok
        ? { ok: true, results: result.data.stays.length }
        : { ok: false, reason: result.reason },
    ),
  );
  if (!result.ok) {
    return (
      <PageNotice tone="error" retryHref={`/stays?${toStayParams(state)}`}>
        {t(ERROR_KEY[result.reason])}
      </PageNotice>
    );
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
  const near = query.filters?.near ?? null;
  // Обране місце (етап 5): відстань у картках і «Ближче до місця».
  const nearPlace = near ? { ...near, name: state.nearName ?? t("chosenPoint") } : null;
  const stays = sortStays(result.data.stays, state.sort, scores, near);
  const pickLabels = new Map<string, StayPickLabel>(
    scoring.picks.map((p) => [p.stay_key, p.label]),
  );
  const pickStays = scoring.picks
    .map((p) => result.data.stays.find((s) => `${s.source}:${s.id}` === p.stay_key))
    .filter((s): s is Stay => s !== undefined);
  const filtered = hasStayFilters(query.filters);
  const withoutFilters = toStayParams({
    ...state,
    query: {
      ...query,
      filters: {
        free_cancellation: false,
        breakfast_included: false,
        no_prepayment: false,
        pay_at_property: false,
      },
    },
  });

  // Карта (модуль 6): маркери лише для об'єктів з координатами — вигаданих не ставимо.
  const view = state.view ?? "list";
  const mapAvailable = (facets.available ?? []).includes("coordinates");
  const mapStays: MapStay[] = stays.flatMap((s) =>
    s.latitude != null && s.longitude != null
      ? [
          {
            key: `${s.source}:${s.id}`,
            anchor: stayAnchor(`${s.source}:${s.id}`),
            name: s.name,
            lat: s.latitude,
            lon: s.longitude,
            price: s.price_per_night,
            currency: s.currency,
            rating: s.rating ?? null,
          },
        ]
      : [],
  );
  const listHref = `/stays?${toStayParams({ ...state, view: "list" })}`;
  const mapBase = toStayParams({
    ...state,
    view: "map",
    query: { ...query, filters: { ...query.filters, bbox: null } as StayQuery["filters"] },
  }).toString();
  const listNode = (
    <>
      {stays.length === 0 ? (
        <div className="grid gap-4">
          {filtered && facets.total_stays > 0 ? (
            <PageNotice>
              {t("filteredEmpty", { total: facets.total_stays })}{" "}
              <Link
                href={`/stays?${withoutFilters}`}
                className="text-primary font-medium underline"
              >
                {t("resetFilters")}
              </Link>
            </PageNotice>
          ) : (
            <PageNotice>{t("empty")}</PageNotice>
          )}
          <EmptySuggestions items={staySuggestions(state)} currency={query.currency ?? "EUR"} />
        </div>
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
                  freshness={result.data.freshness?.[key]}
                  converted={result.data.converted?.[key]}
                  query={query}
                  searchParams={historyParams}
                  detailHref={stayHotelHref(historyParams, stay)}
                  nearPlace={nearPlace}
                />
              ),
            };
          })}
        />
      )}
    </>
  );

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
          {/* «Поділитися» (модуль 20.1): лише параметри пошуку з канонічного URL. */}
          <ShareLink href={`/stays?${historyParams}`} testId="search-share" />
          <RememberSearch kind="stays" params={historyParams} title={historyTitle} />
          {mapAvailable && <ViewToggle state={state} />}
          <SortToggle state={state} />
        </div>
      </div>
      {/* Сповіщення про житло (11a) — лише з реальним джерелом житла; інакше пояснення. */}
      {alertChannels && (
        <PriceAlert
          target={stayTarget(query)}
          bestPrice={stays.length ? Math.round(Math.min(...stays.map((s) => s.total_price))) : null}
          channels={alertChannels}
        />
      )}
      {query.filters?.bbox && (
        <p className="bg-accent/60 text-accent-foreground flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-xs">
          {t("areaFilter")}
          <Link href={`/stays?${mapBase}`} className="text-primary font-medium underline">
            {t("clearArea")}
          </Link>
        </p>
      )}

      <ProviderAlerts providers={result.data.providers} kind="stays" />

      <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start">
        {facets.total_stays > 0 && (
          <StayFilters
            key={toStayParams(state).toString()}
            filters={query.filters ?? {}}
            facets={facets}
            baseParams={[...withoutFilters]}
            airports={result.data.place?.airports ?? []}
            currency={query.currency ?? "EUR"}
            city={query.city}
            nearName={state.nearName}
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

          {view === "map" && mapStays.length > 0 ? (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start">
              {/* Широкий екран — компактний список і карта поруч; вужчий — лише карта (повні картки — режим «Список»). */}
              <div className="hidden lg:block">
                <StayMapList stays={stays} listHref={listHref} />
              </div>
              <div className="lg:sticky lg:top-20">
                <StayMapLazy
                  key={toStayParams(state).toString()}
                  stays={mapStays}
                  withoutCoordinates={stays.length - mapStays.length}
                  baseParams={mapBase}
                  listHref={listHref}
                  point={nearPlace}
                />
              </div>
            </div>
          ) : (
            listNode
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

function SortToggle({ state }: { state: StayState }) {
  const t = useTranslations("stayResults");
  const tShared = useTranslations("results");
  const labels: Record<StaySortKey, string> = {
    price: t("sortPrice"),
    rating: t("sortRating"),
    score: t("sortScore"),
    near: t("sortNear"),
  };
  // «Ближче до місця» — лише коли місце обрано (етап 5).
  const keys = STAY_SORT_KEYS.filter((key) => key !== "near" || state.query.filters?.near);
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground hidden sm:inline">{tShared("sortBy")}</span>
      <div className="bg-muted inline-flex rounded-lg p-1">
        {keys.map((key) => (
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
      <RecentSearches />
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

function ResultsSkeleton() {
  const t = useTranslations("stayResults");
  // Не нижче за екран: футер не видно, доки йдуть результати, — без зсуву (етап 9 V3).
  return (
    <div className="grid min-h-dvh content-start gap-4" aria-busy>
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

/** Режими «Список» / «Карта» (модуль 6); на широкому екрані «Карта» — список і карта поруч. */
function ViewToggle({ state }: { state: StayState }) {
  const t = useTranslations("stayMap");
  const views: ["list" | "map", typeof List][] = [
    ["list", List],
    ["map", MapIcon],
  ];
  return (
    <div
      className="bg-muted inline-flex rounded-lg p-1 text-sm"
      role="group"
      aria-label={t("title")}
    >
      {views.map(([view, Icon]) => {
        const active = (state.view ?? "list") === view;
        return (
          <Link
            key={view}
            href={`/stays?${toStayParams({ ...state, view })}`}
            aria-current={active ? "page" : undefined}
            scroll={false}
            className={cn(
              "text-muted-foreground hover:text-foreground flex items-center gap-1.5 rounded-md px-3 py-1.5 transition-colors",
              active && "bg-card text-primary font-medium shadow-sm",
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {t(view)}
          </Link>
        );
      })}
    </div>
  );
}
