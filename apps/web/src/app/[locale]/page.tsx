import type { Exclusion, FlightSearchResult, Offer, OfferScore, PickLabel } from "@tickets/shared";
import {
  BedDouble,
  CalendarDays,
  ChevronDown,
  Clock,
  Info,
  Luggage,
  Plane,
  Scale,
  Search,
  Sparkles,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { after } from "next/server";
import { Suspense } from "react";

import { AIChat } from "@/components/ai-chat";
import { AIExplanation } from "@/components/ai-explanation";
import { CollapsibleSearch } from "@/components/collapsible-search";
import { EmptySuggestions } from "@/components/empty-suggestions";
import { OfferCard } from "@/components/offer-card";
import { HeroBackdrop, SiteFooter } from "@/components/page-chrome";
import { LinkPendingOverlay } from "@/components/pending";
import { AlertUnavailable, PriceAlert } from "@/components/price-alert";
import { flightTarget } from "@/lib/alerts";
import { flightSuggestions } from "@/lib/empty-suggestions";
import { CompareBar, CompareProvider, CompareToggle } from "@/components/compare";
import { FavoriteToggle, FavoritesProvider } from "@/components/favorites";
import { flightFavorite } from "@/lib/favorites";
import { DateOptions } from "@/components/date-options";
import { PriceCalendar } from "@/components/price-calendar";
import { PriceMatrix } from "@/components/price-matrix";
import { SellerOffers } from "@/components/seller-offers";
import { ProviderAlerts } from "@/components/provider-alerts";
import { ResultFilters } from "@/components/result-filters";
import { SaveSearch } from "@/components/save-search";
import { ShareLink } from "@/components/share-link";
import { RecentSearches, RememberSearch } from "@/components/recent-searches";
import { SearchForm } from "@/components/search-form";
import { PageNotice } from "@/components/page-notice";
import { SearchModes } from "@/components/search-modes";
import { SearchTabs } from "@/components/search-tabs";
import { ShowMore } from "@/components/show-more";
import { SiteHeader } from "@/components/site-header";
import { offerAnchor, TopPicks } from "@/components/top-picks";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  ERROR_KEY,
  explainSearch,
  fetchAIStatus,
  fetchAlertChannels,
  fetchCalendar,
  fetchMatrix,
  searchFlights,
} from "@/lib/api";
import {
  addDays,
  hasFilters,
  parseSearchParams,
  type RawSearchParams,
  type SearchState,
  SORT_KEYS,
  type SortKey,
  passengerTotal,
  toSearchParams,
} from "@/lib/search-params";
import { dateRange, peopleCount } from "@/lib/summary";
import {
  flightDefaults,
  flightPreferences,
  flightPrefFilters,
  mergeFilters,
  withCarried,
} from "@/lib/search-prefs";
import { currentAccount, recordHistory, sessionToken } from "@/lib/session";
import { commonFrom, isDraft } from "@/lib/search-modes";
import { tripFromFlight } from "@/lib/trip-params";
import { searchEvents } from "@/lib/server-analytics";
import { fractionDigits } from "@/lib/money";
import { sortOffers } from "@/lib/sort";
import { cn } from "@/lib/utils";

type Params = Promise<RawSearchParams>;

const EXAMPLES = [
  { from: "WAW", to: "LIS", depart: "2026-12-05", return: "2026-12-12", flex: "2" },
  { from: "WAW", to: "BCN", depart: "2026-12-10", flex: "3" },
  { from: "KRK", to: "LON", depart: "2026-11-20" },
] as const;

export default function HomePage({ searchParams }: PageProps<"/[locale]">) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <SiteHeader active="flights" />
      <main id="main" tabIndex={-1} className="outline-none flex-1">
        {/* overflow-x-clip (не hidden) і z-10: розкривні блоки форми (пасажири, підказки міст)
            можуть виходити за низ секції поверх результатів, а декор фону не дає горизонтального скролу. */}
        <section className="relative isolate z-10 overflow-x-clip border-b">
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
  const t = await getTranslations("home");
  // На сторінці результатів видимого заголовка немає — h1 лише для screen reader і структури.
  if (Object.keys(await searchParams).length > 0) {
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
      <ul className="text-muted-foreground mt-1 flex flex-wrap gap-x-4 gap-y-1.5 text-xs sm:text-sm">
        {POINTS.map(({ key, icon: Icon }) => (
          <li key={key} className="flex items-center gap-1.5">
            <Icon className="text-primary size-3.5" aria-hidden />
            {t(`points.${key}`)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Форма і (коли увімкнено LLM) ШІ-помічник — у вкладках однієї картки. */
async function SearchArea({ searchParams }: { searchParams: Params }) {
  const [status, raw, account] = await Promise.all([
    fetchAIStatus(),
    searchParams,
    currentAccount(),
  ]);
  // Фільтри «Зберегти налаштування» + особисті налаштування пошуку з профілю (модуль 10b).
  const savedFilters = account
    ? mergeFilters(account.flight_filters ?? null, flightPrefFilters(account.search_prefs))
    : null;
  const state = isDraft(raw) ? null : parseSearchParams(raw);
  // key: при новому пошуку форма скидається до значень з URL.
  const form = (
    <SearchForm
      key={state ? toSearchParams(state).toString() : "empty"}
      initial={state}
      savedFilters={savedFilters}
      defaults={withCarried(
        account ? flightDefaults(account) : null,
        state ? null : commonFrom("flights", raw),
      )}
    />
  );
  // На мобільному на сторінці результатів форма згортається в рядок «що шукаємо».
  const searchForm = state ? (
    <CollapsibleSearch
      title={`${state.query.origin} → ${state.query.destination}`}
      details={`${await dateRange(state.query.departure_date, state.query.return_date)} · ${await peopleCount(state.query.passengers?.adults ?? 1, passengerTotal(state.query.passengers) - (state.query.passengers?.adults ?? 1))}`}
    >
      {form}
    </CollapsibleSearch>
  ) : (
    form
  );
  const withModes = (inner: React.ReactNode) => (
    <SearchModes
      current="flights"
      common={commonFrom("flights", raw)}
      drafting={!state}
      ai={status.enabled}
    >
      {inner}
    </SearchModes>
  );
  if (!status.enabled) return withModes(searchForm);
  return withModes(
    <SearchTabs
      form={searchForm}
      chat={
        <AIChat
          currentSearch={state?.query}
          homeAirport={state?.query.origin ?? account?.home_airport ?? undefined}
        />
      }
    />,
  );
}

/** «Додати до поїздки» (модуль 15): планувальник із цим рейсом; лише туди-назад. */
function AddToTrip({ href }: { href: string | null }) {
  const t = useTranslations("offer");
  if (!href) return null;
  return (
    <Button asChild variant="outline" size="sm" className="w-full">
      <Link href={href} data-testid="offer-add-to-trip">
        <Luggage className="size-3.5" aria-hidden />
        {t("addToTrip")}
      </Link>
    </Button>
  );
}

/**
 * Скільки й чому відсіяли обов'язкові вимоги (модуль 14.1): дешевший рейс з пересадкою при
 * «лише прямі» не рекомендуємо — і чесно кажемо, що він був.
 */
function ExcludedNote({ excluded }: { excluded: Exclusion[] }) {
  const t = useTranslations("results");
  const format = useFormatter();
  const count = excluded.reduce((sum, e) => sum + e.offers, 0);
  if (count === 0) return null;
  const reasons = format.list(
    excluded.map((e) => t(`excludedReason.${e.reason}`, { count: e.offers })),
  );
  return (
    <p className="text-muted-foreground text-xs" data-testid="excluded-note">
      {t("excluded", { count, reasons })}
    </p>
  );
}

/** Пояснення ШІ вантажиться окремо: результати не чекають на модель. */
async function ExplanationIfEnabled({ state }: { state: SearchState }) {
  const status = await fetchAIStatus();
  if (!status.enabled) return null;
  // Ті самі уподобання, що й у видачі: пояснення — про той самий вибір скорингу.
  const preferences = flightPreferences((await currentAccount())?.search_prefs);
  const query = preferences ? { ...state.query, preferences } : state.query;
  const result = await explainSearch(query, await getLocale());
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
  const state = isDraft(raw) ? null : parseSearchParams(raw);
  const t = await getTranslations("results");

  if (!state) {
    const hasInput = Object.keys(raw).length > 0 && !isDraft(raw);
    return hasInput ? (
      <PageNotice>{(await getTranslations("search"))("invalid")}</PageNotice>
    ) : (
      <EmptyState />
    );
  }

  const { query } = state;
  // Місяць календаря можна гортати (`cal=`), не змінюючи сам пошук.
  const month = calendarMonth(raw.cal, query.departure_date);
  const matrixRange = matrixWindow(query);
  const account = await currentAccount();
  const preferences = flightPreferences(account?.search_prefs);
  const [result, calendar, alertChannels, matrix] = await Promise.all([
    searchFlights(preferences ? { ...query, preferences } : query),
    fetchCalendar(query.origin, query.destination, month, query.currency ?? "EUR"),
    fetchAlertChannels(),
    matrixRange
      ? fetchMatrix(query.origin, query.destination, ...matrixRange, query.currency ?? "EUR")
      : null,
  ]);
  const now = new Date();
  const alertTarget = flightTarget(query);

  // Аналітика пошуку (модуль 19): анонімно — режим і результат, без маршруту чи дат.
  after(
    await searchEvents(
      "flights",
      result.ok
        ? { ok: true, results: result.data.offers.length }
        : { ok: false, reason: result.reason },
    ),
  );
  if (!result.ok) {
    return (
      <PageNotice tone="error" retryHref={`/?${toSearchParams(state)}`}>
        {t(ERROR_KEY[result.reason])}
      </PageNotice>
    );
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
  const format = await getFormatter();
  // «від …» у рядку інших дат: туди-назад — з матриці (ціна за поїздку), в один бік — з календаря.
  const currency = query.currency ?? "EUR";
  const otherPrices = (
    matrix?.ok ? matrix.data.cells : calendar.ok && !query.return_date ? calendar.data.days : []
  )
    .filter((c) => c.currency === currency)
    .map((c) => c.price);
  const otherFrom = otherPrices.length ? Math.min(...otherPrices) : null;
  const scores = new Map<string, OfferScore>(scoring.scores.map((s) => [s.offer_key, s]));
  const offers = sortOffers(result.data.offers, state.sort, scores);
  // Той самий рейс від кількох джерел — одна картка (найдешевша), решта — рядки продавців у ній.
  const byKey = new Map(result.data.offers.map((o) => [`${o.source}:${o.id}`, o]));
  const groupOf = new Map<string, string[]>();
  for (const group of result.data.groups ?? []) {
    for (const key of group.offer_keys) groupOf.set(key, group.offer_keys);
  }
  const isGroupLead = (o: Offer) => {
    const key = `${o.source}:${o.id}`;
    return (groupOf.get(key)?.[0] ?? key) === key;
  };
  const groupRows = (key: string): Offer[] =>
    (groupOf.get(key) ?? [key]).flatMap((k) => byKey.get(k) ?? []);
  const pickLabels = new Map<string, PickLabel>(scoring.picks.map((p) => [p.offer_key, p.label]));
  const pickAlso = new Map<string, PickLabel[]>(
    scoring.picks.map((p) => [p.offer_key, p.also ?? []]),
  );
  const airlineNames = Object.fromEntries(facets.airlines.map((a) => [a.code, a.name]));
  const checkedSources = result.data.providers
    .filter((p) => p.status === "ok")
    .map((p) =>
      t.has(`provider.${p.provider}`)
        ? t(`provider.${p.provider as "serpapi" | "scrapedo" | "travelpayouts" | "mock"}`)
        : p.provider,
    );
  const filtered = hasFilters(query.filters);
  const withoutFilters = toSearchParams({ ...state, query: { ...query, filters: {} } });
  return (
    <FavoritesProvider>
      <CompareProvider>
        <div className="animate-in fade-in-0 grid gap-6 pb-16 duration-300">
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
                {query.origin_radius_km || query.destination_radius_km
                  ? ` · ${t("withNearby")}`
                  : null}
              </p>
              <ExcludedNote excluded={result.data.excluded ?? []} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <SaveSearch
                kind="flights"
                params={historyParams}
                title={historyTitle}
                back={`/?${historyParams}`}
              />
              {/* «Поділитися» (модуль 20.1): лише параметри пошуку з канонічного URL. */}
              <ShareLink href={`/?${historyParams}`} testId="search-share" />
              <RememberSearch kind="flights" params={historyParams} title={historyTitle} />
              <SortToggle state={state} />
            </div>
          </div>

          {/* Підписка на ціну (етап 7, модуль 11a): поріг — від найкращої ціни за всіх. Перевірки
          йдуть за кешованими цінами дорослих в економі (ADR 0010, 0013): для дітей чи іншого
          класу підписку не пропонуємо — пояснюємо чому. */}
          {alertChannels &&
            (alertTarget ? (
              <PriceAlert
                target={alertTarget}
                bestPrice={result.data.offers[0] ? Math.round(result.data.offers[0].price) : null}
                channels={alertChannels}
              />
            ) : (
              <AlertUnavailable kind="party" />
            ))}

          {/* 2. Проблеми з джерелами — до результатів, щоб було ясно, чому їх мало. */}
          <ProviderAlerts providers={result.data.providers} />

          {/* 3. Гнучкі дати: найкраща ціна на кожну пару дат (модуль 2a). */}
          <DateOptions options={result.data.date_options ?? []} state={state} now={now} />

          {/* 4. Сусідні дати (модуль 23e): згорнуто в один рядок з найнижчою ціною — це
          другорядне, головне нижче — квитки. Гортання місяців календаря (`cal=`) лишає відкритим. */}
          <details
            className="bg-card group rounded-xl border shadow-xs"
            open={raw.cal !== undefined}
            data-testid="other-dates"
          >
            <summary className="hover:bg-muted/40 flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-3 select-none">
              <span className="flex items-center gap-2 text-sm font-semibold">
                <CalendarDays className="text-primary size-4" aria-hidden />
                {t("otherDates")}
              </span>
              <span className="text-muted-foreground flex items-center gap-2 text-sm">
                {otherFrom != null && (
                  <span>
                    {t("otherDatesFrom", {
                      price: format.number(otherFrom, {
                        style: "currency",
                        currency: query.currency ?? "EUR",
                        currencyDisplay: "narrowSymbol",
                        ...fractionDigits(otherFrom),
                      }),
                    })}
                  </span>
                )}
                <ChevronDown
                  className="size-4 transition-transform group-open:rotate-180"
                  aria-hidden
                />
              </span>
            </summary>
            <div className="grid gap-4 border-t p-3 sm:p-4">
              {matrix?.ok && <PriceMatrix matrix={matrix.data} state={state} />}
              {calendar.ok ? (
                <PriceCalendar
                  month={month}
                  days={calendar.data.days}
                  state={state}
                  now={now}
                  verified={verifiedDays(query, result.data)}
                />
              ) : (
                <p className="text-muted-foreground text-sm">
                  {(await getTranslations("calendar"))("unavailable")}
                </p>
              )}
            </div>
          </details>

          {/* 4. Фільтри збоку, справа — вибір, пояснення і весь список. */}
          <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start">
            {facets.total_offers > 0 && (
              <ResultFilters
                key={toSearchParams(state).toString()}
                filters={query.filters ?? {}}
                airlines={facets.airlines}
                baseParams={[...withoutFilters]}
                roundTrip={!!query.return_date}
                currency={query.currency ?? "EUR"}
              />
            )}

            <div className="grid gap-6 lg:col-start-2">
              <TopPicks scoring={scoring} offers={result.data.offers} />

              {offers.length > 0 && (
                <Suspense key={toSearchParams(state).toString()} fallback={<ExplanationSkeleton />}>
                  <ExplanationIfEnabled state={state} />
                </Suspense>
              )}

              <p
                className="bg-accent/60 text-accent-foreground flex items-start gap-2 rounded-lg px-3 py-2 text-xs"
                data-testid="price-note"
              >
                <Info className="mt-px size-3.5 shrink-0" aria-hidden />
                <span>
                  {offers.length > 0 && offers.every(isLivePrice)
                    ? t("liveNote")
                    : offers.some(isLivePrice)
                      ? t("mixedNote")
                      : t("cachedNote")}
                  {/* Чесно (модуль 22.7): найнижча — серед перевірених джерел, а не всього ринку. */}
                  {offers.length > 0 && checkedSources.length > 0 && (
                    <> {t("checkedSources", { sources: checkedSources.join(", ") })}</>
                  )}
                </span>
              </p>

              {offers.length === 0 ? (
                <div className="grid gap-4">
                  {filtered && facets.total_offers > 0 ? (
                    <PageNotice>
                      {t("filteredEmpty", { total: facets.total_offers })}{" "}
                      <Link
                        href={`/?${withoutFilters}`}
                        className="text-primary font-medium underline"
                      >
                        {t("resetFilters")}
                      </Link>
                    </PageNotice>
                  ) : (
                    <PageNotice>{t("empty")}</PageNotice>
                  )}
                  <EmptySuggestions
                    items={flightSuggestions(state)}
                    currency={query.currency ?? "EUR"}
                  />
                </div>
              ) : (
                <ShowMore
                  items={offers.filter(isGroupLead).map((offer, index) => {
                    const key = `${offer.source}:${offer.id}`;
                    return {
                      key: offerAnchor(key),
                      node: (
                        <OfferCard
                          offer={offer}
                          now={now}
                          pickLabel={pickLabels.get(key)}
                          pickAlso={pickAlso.get(key)}
                          sellerCount={groupRows(key).length}
                          compare={
                            // Другорядні дії (модуль 23e): «Порівняти» й «В обране» — в один рядок,
                            // «Додати до поїздки» — окремо; головна — «Переглянути пропозицію».
                            <div className="grid gap-1.5">
                              <div className="grid grid-cols-2 gap-1.5">
                                <CompareToggle offer={offer} />
                                <FavoriteToggle
                                  compact
                                  body={flightFavorite(offer, state.query, historyParams)}
                                />
                              </div>
                              <AddToTrip href={tripFromFlight(offer, state.query)} />
                            </div>
                          }
                          score={scores.get(key)}
                          freshness={result.data.freshness?.[key]}
                          converted={result.data.converted?.[key]}
                          airlineNames={airlineNames}
                          travellers={passengerTotal(state.query.passengers)}
                          baggageCost={result.data.baggage?.[key]}
                          baggageNeed={state.query.baggage ?? "none"}
                          sellers={
                            <SellerOffers
                              offer={offer}
                              rows={groupRows(key)}
                              query={state.query}
                              now={now.toISOString()}
                              // Етап 2 (модуль 22.9): продавці першого рейсу — одразу, без кнопки.
                              autoCheck={index < AUTO_SELLER_CHECKS}
                            />
                          }
                        />
                      ),
                    };
                  })}
                />
              )}
            </div>
          </div>
        </div>
        {/* Порівняння до трьох варіантів (модуль 4.2): панель унизу й таблиця. */}
        <CompareBar airlineNames={airlineNames} />
      </CompareProvider>
    </FavoritesProvider>
  );
}

/** Скільки перших карток самі порівнюють продавців: кожна — 1 запит SerpApi (кеш 30 хв). */
const AUTO_SELLER_CHECKS = 1;

/** Живий пошук: провайдер зафіксував ціну в момент нашого запиту. */
function isLivePrice(offer: Offer): boolean {
  return offer.found_at != null && offer.found_at === offer.collected_at;
}

function SortToggle({ state }: { state: SearchState }) {
  const t = useTranslations("results");
  const labels: Record<SortKey, string> = {
    price: t("sortPrice"),
    duration: t("sortDuration"),
    departure: t("sortDeparture"),
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

/** Три головні можливості (модуль 12.3) — без обіцянок на кшталт «найнижча ціна». */
const FEATURES = [
  { key: "search", icon: Search },
  { key: "compare", icon: Scale },
  { key: "budget", icon: Wallet },
] as const;

/** Що вміє SkyPack — коротко під заголовком (модуль 12.1). */
const POINTS = [
  { key: "flights", icon: Plane },
  { key: "compare", icon: Scale },
  { key: "stays", icon: BedDouble },
  { key: "trip", icon: Luggage },
  { key: "time", icon: Clock },
] as const;

function EmptyState() {
  const t = useTranslations("home");
  return (
    <div className="grid gap-10 py-4">
      <RecentSearches />
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
      <ul className="grid gap-3 sm:grid-cols-3" aria-label={t("featuresLabel")}>
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

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MATRIX_DAYS = 3;

/** `cal=YYYY-MM` — місяць календаря; інакше місяць дати вильоту. */
function calendarMonth(value: string | string[] | undefined, departure: string): string {
  const cal = Array.isArray(value) ? value[0] : value;
  return cal && MONTH.test(cal) ? cal : departure.slice(0, 7);
}

/** Матриця туди-назад: ±3 дні навколо дат пошуку (7 × 7), лише для туди й назад. */
function matrixWindow(query: SearchState["query"]): [[string, string], [string, string]] | null {
  if (!query.return_date) return null;
  const around = (d: string): [string, string] => [
    addDays(d, -MATRIX_DAYS),
    addDays(d, MATRIX_DAYS),
  ];
  return [around(query.departure_date), around(query.return_date)];
}

/**
 * Дні, ціну на які щойно перевірило живе джерело, — для позначки в календарі в один бік
 * (ціни туди-назад з календарем в один бік не порівнюємо).
 */
function verifiedDays(
  query: SearchState["query"],
  result: FlightSearchResult,
): Record<string, number> {
  // Календар — ціна одного дорослого в економі: інший склад чи клас не порівнюємо.
  const single = passengerTotal(query.passengers) === 1 && (query.cabin ?? "economy") === "economy";
  if (query.return_date || !single) return {};
  const days: Record<string, number> = {};
  for (const o of result.date_options ?? []) {
    if (o.verified) days[o.departure] = Math.min(days[o.departure] ?? Infinity, o.price);
  }
  if (!query.flex_days && !query.departure_until && result.offers.length > 0) {
    days[query.departure_date] = Math.min(...result.offers.map((o) => o.price));
  }
  return days;
}
