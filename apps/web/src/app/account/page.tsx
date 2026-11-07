import type { Account, AccountAlert, AuthStatus, SearchEntry, SearchKind } from "@tickets/shared";
import {
  BedDouble,
  Bell,
  CheckCircle2,
  History,
  KeyRound,
  LogOut,
  Luggage,
  Mail,
  Plane,
  Send,
  Star,
  Trash2,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { clearHistory, deleteSearch, logout } from "@/app/actions/account";
import {
  DeleteAccountForm,
  EmailForm,
  PasswordForm,
  ProfileForm,
  RenameForm,
  TelegramForm,
  UnlinkGoogleForm,
} from "@/components/account-forms";
import { GoogleButton } from "@/components/google-button";
import { HeroBackdrop, SiteFooter } from "@/components/page-chrome";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { RawSearchParams } from "@/lib/search-params";
import { call, sessionToken } from "@/lib/session";
import { cn } from "@/lib/utils";

const KIND_ICON = { flights: Plane, stays: BedDouble, trip: Luggage } as const;
const KIND_PATH: Record<SearchKind, string> = { flights: "/", stays: "/stays", trip: "/trip" };
const SECTIONS = [
  { id: "profile", icon: UserRound },
  { id: "security", icon: KeyRound },
  { id: "saved", icon: Star },
  { id: "history", icon: History },
  { id: "alerts", icon: Bell },
  { id: "danger", icon: TriangleAlert },
] as const;

export default function AccountPage({ searchParams }: PageProps<"/account">) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <SiteHeader active={null} />
      <main className="relative isolate flex-1">
        <HeroBackdrop />
        <div className="mx-auto w-full max-w-6xl px-4 py-8">
          <Suspense fallback={<div className="shimmer h-96 rounded-xl" />}>
            <AccountContent searchParams={searchParams} />
          </Suspense>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

async function AccountContent({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const token = await sessionToken();
  if (!token) redirect("/login?next=/account");
  const [account, saved, history, alerts, status, raw] = await Promise.all([
    call<Account>("GET", "/account", undefined, token),
    call<SearchEntry[]>("GET", "/account/searches?saved=true", undefined, token),
    call<SearchEntry[]>("GET", "/account/searches?saved=false&limit=30", undefined, token),
    call<AccountAlert[]>("GET", "/account/alerts", undefined, token),
    call<AuthStatus>("GET", "/auth/status", undefined, null),
    searchParams,
  ]);
  if (!account.ok) redirect("/login?next=/account");
  const t = await getTranslations("account");
  const done = typeof raw.done === "string" ? raw.done : null;
  const error = typeof raw.error === "string" ? raw.error : null;
  return (
    <AccountView
      account={account.data}
      saved={saved.ok ? saved.data : []}
      history={history.ok ? history.data : []}
      alerts={alerts.ok ? alerts.data : []}
      google={status.ok && status.data.google}
      mailMock={status.ok && status.data.email === "mock"}
      done={done && t.has(`done.${done}`) ? t(`done.${done}`) : null}
      error={error}
    />
  );
}

function AccountView({
  account,
  saved,
  history,
  alerts,
  google,
  mailMock,
  done,
  error,
}: {
  account: Account;
  saved: SearchEntry[];
  history: SearchEntry[];
  alerts: AccountAlert[];
  google: boolean;
  mailMock: boolean;
  done: string | null;
  error: string | null;
}) {
  const t = useTranslations("account");
  const tErr = useTranslations("authErrors");
  const format = useFormatter();
  const name = [account.first_name, account.last_name].filter(Boolean).join(" ");
  const since = format.dateTime(new Date(account.created_at), { month: "long", year: "numeric" });

  return (
    <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start">
      <aside className="bg-card grid gap-4 rounded-xl border p-4 shadow-xs lg:sticky lg:top-20">
        <div className="flex items-center gap-3">
          <span className="from-primary grid size-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br to-sky-500 text-lg font-bold text-white uppercase shadow-md shadow-primary/30">
            {(account.first_name || account.username).slice(0, 1)}
          </span>
          <div className="min-w-0">
            <p className="truncate font-semibold">{name || account.username}</p>
            <p className="text-muted-foreground truncate text-xs">@{account.username}</p>
          </div>
        </div>
        <nav aria-label={t("sections")} className="-mx-1 flex gap-1 overflow-x-auto lg:grid">
          {SECTIONS.map(({ id, icon: Icon }) => (
            <a
              key={id}
              href={`#${id}`}
              className="text-muted-foreground hover:text-primary hover:bg-accent flex shrink-0 items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors"
            >
              <Icon className="size-4" aria-hidden />
              {t(`nav.${id}`)}
            </a>
          ))}
        </nav>
        <p className="text-muted-foreground hidden text-xs lg:block">
          {t("since", { date: since })}
        </p>
        <form action={logout} className="hidden lg:block">
          <Button type="submit" variant="outline" size="sm" className="w-full">
            <LogOut className="size-4" aria-hidden />
            {t("logout")}
          </Button>
        </form>
      </aside>

      <div className="grid gap-6">
        {done && (
          <p
            role="status"
            className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-300"
          >
            <CheckCircle2 className="size-4" aria-hidden />
            {done}
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

        <Section id="profile" title={t("nav.profile")} hint={t("profileHint")}>
          <ProfileForm account={account} />
        </Section>

        <Section id="security" title={t("nav.security")}>
          <Block icon={Mail} title={t("emailTitle")}>
            {account.email ? (
              <p className="text-sm">
                {t("emailCurrent")} <span className="font-medium">{account.email}</span>
              </p>
            ) : (
              <p className="text-muted-foreground text-sm">{t("emailNone")}</p>
            )}
            {account.pending_email && (
              <p className="text-sm text-amber-700 dark:text-amber-400">
                {t("emailPending", { email: account.pending_email })}
              </p>
            )}
            {mailMock && <p className="text-muted-foreground text-[11px]">{t("mailMock")}</p>}
            <EmailForm account={account} />
          </Block>

          <Block
            icon={KeyRound}
            title={account.has_password ? t("passwordTitle") : t("setPasswordTitle")}
          >
            {!account.has_password && (
              <p className="text-muted-foreground text-sm">{t("noPassword")}</p>
            )}
            <PasswordForm hasPassword={account.has_password} />
          </Block>

          <Block icon={UserRound} title={t("loginMethods")}>
            <ul className="grid gap-2 text-sm">
              <li className="flex flex-wrap items-center justify-between gap-2">
                <span>{t("methodPassword", { username: account.username })}</span>
                <Status on={account.has_password} />
              </li>
              <li className="grid gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>Google</span>
                  <Status on={account.google_linked} />
                </div>
                {account.google_linked ? (
                  <UnlinkGoogleForm />
                ) : (
                  <div className="max-w-xs">
                    <GoogleButton enabled={google} mode="link" />
                  </div>
                )}
              </li>
              <li className="grid gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5">
                    <Send className="size-3.5" aria-hidden />
                    Telegram
                  </span>
                  <Status on={account.telegram_linked} />
                </div>
                <TelegramForm
                  key={String(account.telegram_linked)}
                  linked={account.telegram_linked}
                />
              </li>
            </ul>
            <form action={logout}>
              <input type="hidden" name="everywhere" value="1" />
              <Button type="submit" variant="outline" size="sm">
                <LogOut className="size-4" aria-hidden />
                {t("logoutEverywhere")}
              </Button>
            </form>
          </Block>
        </Section>

        <Section id="saved" title={t("nav.saved")} hint={t("savedHint")}>
          <Entries entries={saved} empty={t("savedEmpty")} renamable />
        </Section>

        <Section
          id="history"
          title={t("nav.history")}
          hint={t("historyHint")}
          action={
            history.length > 0 && (
              <form action={clearHistory}>
                <Button
                  type="submit"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="size-4" aria-hidden />
                  {t("clearHistory")}
                </Button>
              </form>
            )
          }
        >
          <Entries entries={history} empty={t("historyEmpty")} />
        </Section>

        <Section id="alerts" title={t("nav.alerts")} hint={t("alertsHint")}>
          {alerts.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("alertsEmpty")}</p>
          ) : (
            <ul className="grid gap-2">
              {alerts.map((a) => (
                <li key={a.id}>
                  <Link
                    href={`/alerts?token=${a.manage_token}`}
                    className="hover:border-primary/40 flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm transition-colors"
                  >
                    <span className="flex items-center gap-2 font-medium">
                      <Bell className="text-primary size-4" aria-hidden />
                      {a.origin} → {a.destination}
                      <span className="text-muted-foreground font-normal">
                        {format.dateTime(new Date(`${a.departure_date}T00:00:00Z`), {
                          day: "numeric",
                          month: "short",
                          timeZone: "UTC",
                        })}
                      </span>
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {t(`alertStatus.${a.status}`)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section id="danger" title={t("nav.danger")} hint={t("deleteHint")} tone="danger">
          <DeleteAccountForm hasPassword={account.has_password} username={account.username} />
        </Section>
      </div>
    </div>
  );
}

function Section({
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

function Block({
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

function Status({ on }: { on: boolean }) {
  const t = useTranslations("account");
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-xs font-medium",
        on
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          : "bg-muted text-muted-foreground",
      )}
    >
      {on ? t("linked") : t("notLinked")}
    </span>
  );
}

function Entries({
  entries,
  empty,
  renamable = false,
}: {
  entries: SearchEntry[];
  empty: string;
  renamable?: boolean;
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
            className="hover:border-primary/40 flex items-center gap-2 rounded-lg border p-1.5 pr-2 transition-colors"
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
            {renamable && <RenameForm id={entry.id} title={entry.title} />}
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
          </li>
        );
      })}
    </ul>
  );
}
