import type { AccountAlert, FavoriteOut, SavedTrip, SearchEntry } from "@tickets/shared";
import { ArrowRight, Bell, Heart, History, Luggage, Plane, Search, Sparkles } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";

import { AccountPage, Entries, Section, requireAccount } from "@/components/account-shell";
import { toTripParams } from "@/lib/trip-params";
import { call } from "@/lib/session";
import { fractionDigits } from "@/lib/money";

/** Кабінет → «Огляд» (модуль 10a): привітання, швидкі дії, коротко про все головне. */
export default function OverviewPage({ searchParams }: PageProps<"/[locale]/account">) {
  return (
    <AccountPage section="overview" searchParams={searchParams}>
      <Overview />
    </AccountPage>
  );
}

async function Overview() {
  const { account, token } = await requireAccount("overview");
  const [trips, alerts, recent, saved, favorites, t] = await Promise.all([
    call<SavedTrip[]>("GET", "/account/trips", undefined, token),
    call<AccountAlert[]>("GET", "/account/alerts", undefined, token),
    call<SearchEntry[]>("GET", "/account/searches?saved=false&limit=5", undefined, token),
    call<SearchEntry[]>("GET", "/account/searches?saved=true&limit=5", undefined, token),
    call<FavoriteOut[]>("GET", "/account/favorites", undefined, token),
    getTranslations("cabinet"),
  ]);
  const flights = favorites.ok ? favorites.data.filter((f) => f.kind === "flight") : [];
  return (
    <>
      <Section
        id="welcome"
        title={t("hello", { name: account.first_name || account.username })}
        hint={t("helloHint")}
      >
        <QuickActions />
      </Section>
      <div className="grid gap-6 md:grid-cols-2">
        <Trips trips={trips.ok ? trips.data.slice(0, 3) : []} />
        <Alerts alerts={alerts.ok ? alerts.data.filter((a) => a.status === "active") : []} />
        <Section id="recent" title={t("recent")} action={<More href="/account/history" />}>
          <Entries
            entries={recent.ok ? recent.data : []}
            empty={t("recentEmpty")}
            deletable={false}
          />
        </Section>
        <Section id="routes" title={t("routes")} hint={t("routesHint")}>
          <Routes saved={saved.ok ? saved.data : []} flights={flights} />
        </Section>
      </div>
    </>
  );
}

const ACTIONS = [
  { key: "newSearch", href: "/", icon: Search },
  { key: "planTrip", href: "/trip", icon: Sparkles },
  { key: "myTrips", href: "/account/trips", icon: Luggage },
  { key: "newAlert", href: "/account/alerts", icon: Bell },
] as const;

function QuickActions() {
  const t = useTranslations("cabinet");
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="quick-actions">
      {ACTIONS.map(({ key, href, icon: Icon }) => (
        <li key={key}>
          <Link
            href={href}
            className="hover:border-primary/50 hover:bg-accent flex h-full flex-col items-start gap-2 rounded-xl border p-3 text-sm font-medium transition-colors"
          >
            <span className="bg-accent text-primary grid size-8 place-items-center rounded-lg">
              <Icon className="size-4" aria-hidden />
            </span>
            {t(`action.${key}`)}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function More({ href }: { href: string }) {
  const t = useTranslations("cabinet");
  return (
    <Link href={href} className="text-primary flex items-center gap-1 text-sm hover:underline">
      {t("all")}
      <ArrowRight className="size-3.5" aria-hidden />
    </Link>
  );
}

function Trips({ trips }: { trips: SavedTrip[] }) {
  const t = useTranslations("cabinet");
  const tTrips = useTranslations("savedTrips");
  const format = useFormatter();
  return (
    <Section id="trips" title={t("trips")} action={<More href="/account/trips" />}>
      {trips.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t("tripsEmpty")}{" "}
          <Link href="/trip" className="text-primary underline">
            {t("action.planTrip")}
          </Link>
        </p>
      ) : (
        <ul className="grid gap-2">
          {trips.map((trip) => (
            <li key={trip.id}>
              <Link
                href={`/trip?${toTripParams(trip.query)}&saved=${trip.id}`}
                className="hover:border-primary/40 flex items-center justify-between gap-3 rounded-lg border p-3 text-sm transition-colors"
              >
                <span className="grid min-w-0">
                  <span className="truncate font-medium">{trip.title}</span>
                  <span className="text-muted-foreground text-xs">
                    {tTrips(`status.${trip.status ?? "draft"}`)} ·{" "}
                    {tTrips("pricedAt", {
                      date: format.dateTime(new Date(trip.snapshot.priced_at), {
                        day: "numeric",
                        month: "short",
                      }),
                    })}
                  </span>
                </span>
                <span className="font-semibold tabular-nums">
                  {format.number(trip.snapshot.money_total, {
                    style: "currency",
                    currency: trip.snapshot.currency,
                    currencyDisplay: "narrowSymbol",
                    ...fractionDigits(trip.snapshot.money_total),
                  })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Alerts({ alerts }: { alerts: AccountAlert[] }) {
  const t = useTranslations("cabinet");
  const format = useFormatter();
  return (
    <Section id="alerts" title={t("alerts")} action={<More href="/account/alerts" />}>
      {alerts.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("alertsEmpty")}</p>
      ) : (
        <ul className="grid gap-2">
          {alerts.slice(0, 4).map((a) => (
            <li key={a.id}>
              <Link
                href={`/alerts?token=${a.manage_token}`}
                className="hover:border-primary/40 flex items-center gap-2 rounded-lg border p-3 text-sm transition-colors"
              >
                <Bell className="text-primary size-4" aria-hidden />
                <span className="font-medium">
                  {a.origin} → {a.destination}
                </span>
                <span className="text-muted-foreground">
                  {format.dateTime(new Date(`${a.departure_date}T00:00:00Z`), {
                    day: "numeric",
                    month: "short",
                    timeZone: "UTC",
                  })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** Обрані маршрути: збережені пошуки й обрані квитки — повторити пошук одним кліком. */
function Routes({ saved, flights }: { saved: SearchEntry[]; flights: FavoriteOut[] }) {
  const t = useTranslations("cabinet");
  const items = [
    ...flights.flatMap((f) =>
      f.flight
        ? [
            {
              key: f.item_key,
              href: `/?${f.flight.params}`,
              title: `${f.flight.origin} → ${f.flight.destination}`,
              icon: Heart,
            },
          ]
        : [],
    ),
    ...saved
      .filter((s) => s.kind === "flights")
      .map((s) => ({ key: s.id, href: `/?${s.params}`, title: s.title, icon: History })),
  ].slice(0, 6);
  if (items.length === 0)
    return <p className="text-muted-foreground text-sm">{t("routesEmpty")}</p>;
  return (
    <ul className="grid gap-2">
      {items.map(({ key, href, title, icon: Icon }) => (
        <li key={key}>
          <Link
            href={href}
            className="hover:border-primary/40 flex items-center gap-2 rounded-lg border p-3 text-sm transition-colors"
          >
            <Icon className="text-primary size-4" aria-hidden />
            <Plane className="text-muted-foreground size-3.5" aria-hidden />
            <span className="truncate font-medium">{title}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
