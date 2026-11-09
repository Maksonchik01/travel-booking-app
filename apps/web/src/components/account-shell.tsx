import type { Account, SearchEntry, SearchKind } from "@tickets/shared";
import {
  BedDouble,
  Bell,
  Bookmark,
  CheckCircle2,
  Heart,
  History,
  LayoutDashboard,
  LogOut,
  Luggage,
  Mail,
  Plane,
  Settings,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { deleteSearch, logout, saveHistoryEntry } from "@/app/actions/account";
import { RenameForm } from "@/components/account-forms";
import { HeroBackdrop, SiteFooter } from "@/components/page-chrome";
import { SiteHeader } from "@/components/site-header";
import { UserAvatar } from "@/components/user-avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { type EntryDetails, entryDetails } from "@/lib/entry-details";
import type { RawSearchParams } from "@/lib/search-params";
import { call, sessionToken } from "@/lib/session";
import { cn } from "@/lib/utils";

/** Розділи кабінету (модуль 10a) — окремі сторінки з однаковою навігацією. */
export const ACCOUNT_SECTIONS = [
  { id: "overview", href: "/account", icon: LayoutDashboard },
  { id: "favorites", href: "/account/favorites", icon: Heart },
  { id: "trips", href: "/account/trips", icon: Luggage },
  { id: "history", href: "/account/history", icon: History },
  { id: "alerts", href: "/account/alerts", icon: Bell },
  { id: "settings", href: "/account/settings", icon: Settings },
  { id: "security", href: "/account/security", icon: ShieldCheck },
] as const;
export type AccountSection = (typeof ACCOUNT_SECTIONS)[number]["id"];

export const KIND_ICON = { flights: Plane, stays: BedDouble, trip: Luggage } as const;
export const KIND_PATH: Record<SearchKind, string> = {
  flights: "/",
  stays: "/stays",
  trip: "/trip",
};

/** Акаунт для сторінки кабінету; без входу — на вхід з поверненням у цей розділ. */
export async function requireAccount(section: AccountSection): Promise<{
  account: Account;
  token: string;
}> {
  const href = ACCOUNT_SECTIONS.find((s) => s.id === section)!.href;
  const token = await sessionToken();
  if (!token) redirect(`/login?next=${encodeURIComponent(href)}`);
  const account = await call<Account>("GET", "/account", undefined, token);
  if (!account.ok) redirect(`/login?next=${encodeURIComponent(href)}`);
  return { account: account.data, token };
}

/** Каркас сторінки кабінету: шапка, бічна навігація, повідомлення `done=`/`error=`. */
export function AccountPage({
  section,
  searchParams,
  children,
}: {
  section: AccountSection;
  searchParams: Promise<RawSearchParams>;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <SiteHeader active={null} />
      <main id="main" tabIndex={-1} className="outline-none relative isolate flex-1">
        <HeroBackdrop />
        <div className="mx-auto w-full max-w-6xl px-4 py-8 pb-24">
          <Suspense fallback={<div className="shimmer h-96 rounded-xl" />}>
            <Shell section={section} searchParams={searchParams}>
              {children}
            </Shell>
          </Suspense>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

async function Shell({
  section,
  searchParams,
  children,
}: {
  section: AccountSection;
  searchParams: Promise<RawSearchParams>;
  children: React.ReactNode;
}) {
  const [{ account }, raw, t] = await Promise.all([
    requireAccount(section),
    searchParams,
    getTranslations("account"),
  ]);
  const done = typeof raw.done === "string" && t.has(`done.${raw.done}`) ? raw.done : null;
  const error = typeof raw.error === "string" ? raw.error : null;
  return (
    <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start">
      <Sidebar account={account} section={section} />
      <div className="grid gap-6">
        <Notices done={done} error={error} />
        {children}
      </div>
    </div>
  );
}

function Sidebar({ account, section }: { account: Account; section: AccountSection }) {
  const t = useTranslations("account");
  const format = useFormatter();
  const name = [account.first_name, account.last_name].filter(Boolean).join(" ");
  const since = format.dateTime(new Date(account.created_at), { month: "long", year: "numeric" });
  return (
    <aside className="bg-card grid gap-4 rounded-xl border p-4 shadow-xs lg:sticky lg:top-20">
      <div className="flex items-center gap-3">
        <UserAvatar user={account} size={44} className="shadow-primary/30 rounded-xl shadow-md" />
        <div className="min-w-0">
          <p className="truncate font-semibold">{name || account.username}</p>
          <p className="text-muted-foreground truncate text-xs">@{account.username}</p>
        </div>
      </div>
      <nav aria-label={t("sections")} className="flex flex-wrap gap-1 lg:grid">
        {ACCOUNT_SECTIONS.map(({ id, href, icon: Icon }) => (
          <Link
            key={id}
            href={href}
            aria-current={id === section ? "page" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors",
              id === section
                ? "bg-accent text-primary font-medium"
                : "text-muted-foreground hover:text-primary hover:bg-accent",
            )}
          >
            <Icon className="size-4" aria-hidden />
            {t(`nav.${id}`)}
          </Link>
        ))}
      </nav>
      <p className="text-muted-foreground hidden text-xs lg:block">{t("since", { date: since })}</p>
      <form action={logout} className="hidden lg:block">
        <Button type="submit" variant="outline" size="sm" className="w-full">
          <LogOut className="size-4" aria-hidden />
          {t("logout")}
        </Button>
      </form>
    </aside>
  );
}

function Notices({ done, error }: { done: string | null; error: string | null }) {
  const t = useTranslations("account");
  const tErr = useTranslations("authErrors");
  return (
    <>
      {done && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/5 px-3 py-2 text-sm text-success"
        >
          <CheckCircle2 className="size-4" aria-hidden />
          {t(`done.${done}`)}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="border-destructive/30 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm"
        >
          {tErr.has(error) ? tErr(error) : tErr("default")}
        </p>
      )}
    </>
  );
}

export function Section({
  id,
  title,
  hint,
  action,
  tone,
  children,
}: {
  id: string;
  title: string;
  hint?: string;
  action?: React.ReactNode;
  tone?: "danger";
  children: React.ReactNode;
}) {
  return (
    <Card id={id} className={cn("scroll-mt-20 py-0", tone === "danger" && "border-destructive/30")}>
      <CardContent className="grid gap-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="grid gap-0.5">
            <h2 className={cn("text-lg font-semibold", tone === "danger" && "text-destructive")}>
              {title}
            </h2>
            {hint && <p className="text-muted-foreground text-sm">{hint}</p>}
          </div>
          {action}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

export function Block({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Mail;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-3 border-t pt-4 first:border-t-0 first:pt-0">
      <h3 className="flex items-center gap-2 font-medium">
        <Icon className="text-primary size-4" aria-hidden />
        {title}
      </h3>
      {children}
    </div>
  );
}

export function Status({ on }: { on: boolean }) {
  const t = useTranslations("account");
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-xs font-medium",
        on ? "bg-success/10 text-success" : "bg-muted text-muted-foreground",
      )}
    >
      {on ? t("linked") : t("notLinked")}
    </span>
  );
}

export function Entries({
  entries,
  empty,
  renamable = false,
  deletable = true,
  savable = false,
}: {
  entries: SearchEntry[];
  empty: string;
  renamable?: boolean;
  deletable?: boolean;
  /** Історія: «Зберегти» переносить запис у збережені пошуки. */
  savable?: boolean;
}) {
  const t = useTranslations("account");
  const format = useFormatter();
  if (entries.length === 0) return <p className="text-muted-foreground text-sm">{empty}</p>;
  return (
    <ul className="grid gap-2">
      {entries.map((entry) => {
        const Icon = KIND_ICON[entry.kind];
        return (
          <li
            key={entry.id}
            className="hover:border-primary/40 flex flex-wrap items-center gap-x-2 rounded-lg border p-1.5 pr-2 transition-colors"
          >
            <Link
              href={`${KIND_PATH[entry.kind]}?${entry.params}`}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-md p-1.5"
            >
              <span className="bg-accent text-primary grid size-9 shrink-0 place-items-center rounded-lg">
                <Icon className="size-4" aria-hidden />
              </span>
              <span className="grid min-w-0">
                <span className="truncate text-sm font-medium">{entry.title}</span>
                <span className="text-muted-foreground text-xs">
                  {t(`kind.${entry.kind}`)} ·{" "}
                  {format.dateTime(new Date(entry.updated_at), {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </span>
            </Link>
            {savable && (
              <form action={saveHistoryEntry}>
                <input type="hidden" name="kind" value={entry.kind} />
                <input type="hidden" name="params" value={entry.params} />
                <input type="hidden" name="title" value={entry.title} />
                <button
                  type="submit"
                  aria-label={t("saveEntry", { title: entry.title })}
                  title={t("saveEntry", { title: entry.title })}
                  className="text-muted-foreground hover:text-primary hover:bg-accent grid size-8 place-items-center rounded-md transition-colors"
                >
                  <Bookmark className="size-4" aria-hidden />
                </button>
              </form>
            )}
            {renamable && <RenameForm id={entry.id} title={entry.title} />}
            {deletable && (
              <form action={deleteSearch}>
                <input type="hidden" name="id" value={entry.id} />
                <button
                  type="submit"
                  aria-label={t("deleteEntry", { title: entry.title })}
                  title={t("deleteEntry", { title: entry.title })}
                  className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 grid size-8 place-items-center rounded-md transition-colors"
                >
                  <Trash2 className="size-4" aria-hidden />
                </button>
              </form>
            )}
            <EntryParams details={entryDetails(entry.kind, entry.params)} />
          </li>
        );
      })}
    </ul>
  );
}

/** Головні фільтри — словами; решта — лише кількістю. */
const MAIN_FILTERS = new Set(["stops", "al", "dep", "rating", "kind", "cancel", "dist", "am"]);

/** «Параметри» запису: маршрут, дати, люди, клас, багаж, головні фільтри (п. 10.5). */
function EntryParams({ details }: { details: EntryDetails | null }) {
  const t = useTranslations("account.params");
  const tSearch = useTranslations("search");
  const tFilters = useTranslations("filters");
  const tStay = useTranslations("stayFilters");
  const tCard = useTranslations("stayCard");
  const format = useFormatter();
  if (!details) return null;
  const date = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  const filter = ([key, value]: [string, string]): string => {
    const list = value.split(",");
    switch (key) {
      case "stops":
        return tFilters("maxStops", { count: Number(value) });
      case "al":
        return `${tFilters("airlines")}: ${list.join(", ")}`;
      case "dep":
        return list.map((p) => tFilters(`period.${p}`)).join(", ");
      case "rating":
        return tStay("ratingFrom", { rating: value });
      case "kind":
        return list.map((k) => tCard(`kind.${k}`)).join(", ");
      case "cancel":
        return tStay("freeCancellation");
      case "dist":
        return tStay("upToKm", { km: value });
      default:
        return list.map((a) => tCard(`amenity.${a}`)).join(", ");
    }
  };
  const main = details.filters.filter(([key]) => MAIN_FILTERS.has(key));
  const other = details.filters.length - main.length;
  const rows: [string, string][] = [
    [t("route"), details.route],
    [
      t("dates"),
      details.dates.to
        ? `${date(details.dates.from)} – ${date(details.dates.to)}`
        : date(details.dates.from),
    ],
    [
      t("people"),
      [
        tSearch("adultsCount", { count: details.adults }),
        details.children ? tSearch("childrenCount", { count: details.children }) : null,
        details.rooms && details.rooms > 1 ? t("rooms", { count: details.rooms }) : null,
      ]
        .filter(Boolean)
        .join(", "),
    ],
  ];
  if (details.cabin) rows.push([tSearch("cabin"), tSearch(`cabins.${details.cabin}`)]);
  if (details.baggage) rows.push([tSearch("baggage"), tSearch(`bags.${details.baggage}`)]);
  if (details.budget) rows.push([t("budget"), format.number(details.budget)]);
  if (main.length || other) {
    rows.push([
      t("filters"),
      [...main.map(filter), other ? t("moreFilters", { count: other }) : null]
        .filter(Boolean)
        .join(" · "),
    ]);
  }
  return (
    <details className="group w-full basis-full px-1.5 pb-1 text-xs" data-testid="entry-params">
      <summary className="text-muted-foreground hover:text-primary w-fit cursor-pointer select-none">
        {t("show")}
      </summary>
      <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
