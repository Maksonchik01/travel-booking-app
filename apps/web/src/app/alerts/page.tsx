import type { AlertView } from "@tickets/shared";
import { Bell, BellOff, CheckCircle2, Clock, Plane, Send } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { HeroBackdrop, SiteFooter } from "@/components/page-chrome";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fetchAlert, fetchAlertChannels } from "@/lib/api";
import type { RawSearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

/** Керування підпискою за посиланням із бота чи листа (токен — у посиланні, акаунта немає). */
export default function AlertPage({ searchParams }: PageProps<"/alerts">) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <SiteHeader active="flights" />
      <main className="relative isolate flex-1">
        <HeroBackdrop />
        <div className="mx-auto grid w-full max-w-2xl gap-5 px-4 py-8 sm:py-12">
          <Suspense fallback={<div className="shimmer h-64 rounded-xl" />}>
            <AlertDetails searchParams={searchParams} />
          </Suspense>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

async function AlertDetails({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const raw = await searchParams;
  const token = typeof raw.token === "string" ? raw.token : "";
  const done = typeof raw.done === "string" ? raw.done : null;
  const t = await getTranslations("alertPage");
  const [result, channels] = await Promise.all([
    token ? fetchAlert(token) : Promise.resolve(null),
    fetchAlertChannels(),
  ]);
  if (!result || !result.ok) {
    return (
      <Card className="py-0">
        <CardContent className="grid gap-2 p-6 text-center">
          <BellOff className="text-muted-foreground mx-auto size-8" aria-hidden />
          <h1 className="text-lg font-semibold">{t("notFound")}</h1>
          <p className="text-muted-foreground text-sm">{t("notFoundHint")}</p>
        </CardContent>
      </Card>
    );
  }
  const alert = result.data;
  const telegramLink =
    alert.channel === "telegram" && alert.status === "pending" && channels?.bot_username
      ? `https://t.me/${channels.bot_username}?start=${token}`
      : null;
  return <AlertCard alert={alert} token={token} done={done} telegramLink={telegramLink} />;
}

function AlertCard({
  alert,
  token,
  done,
  telegramLink,
}: {
  alert: AlertView;
  token: string;
  done: string | null;
  telegramLink: string | null;
}) {
  const t = useTranslations("alertPage");
  const format = useFormatter();
  const money = (v: number) =>
    format.number(v, {
      style: "currency",
      currency: alert.currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: 0,
    });
  const date = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    });
  const search = new URLSearchParams({
    from: alert.origin,
    to: alert.destination,
    depart: alert.departure_date,
    ...(alert.return_date ? { return: alert.return_date } : {}),
  });
  const active = alert.status === "pending" || alert.status === "active";

  return (
    <Card className="border-primary/10 shadow-primary/[0.07] py-0 shadow-xl">
      <CardContent className="grid gap-5 p-5 sm:p-6">
        {done && (
          <p
            role="status"
            className={cn(
              "rounded-lg border px-3 py-2 text-sm",
              done === "failed"
                ? "border-amber-500/40 bg-amber-500/10"
                : "border-emerald-500/40 bg-emerald-500/5 text-emerald-800 dark:text-emerald-300",
            )}
          >
            {t(`done.${done === "confirm" || done === "stop" ? done : "failed"}`)}
          </p>
        )}

        <div className="grid gap-1">
          <p className="text-muted-foreground flex items-center gap-2 text-xs font-semibold tracking-wide uppercase">
            <Bell className="text-primary size-3.5" aria-hidden />
            {t("title")}
          </p>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            {alert.origin}
            <Plane className="text-primary size-5" aria-hidden />
            {alert.destination}
          </h1>
          <p className="text-muted-foreground text-sm">
            {alert.return_date
              ? `${date(alert.departure_date)} – ${date(alert.return_date)}`
              : date(alert.departure_date)}{" "}
            · {t("adults", { count: alert.adults })}
          </p>
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t("status")}</dt>
          <dd>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-xs font-medium",
                alert.status === "active" &&
                  "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
                alert.status === "pending" && "bg-amber-500/10 text-amber-700 dark:text-amber-400",
                (alert.status === "stopped" || alert.status === "expired") &&
                  "bg-muted text-muted-foreground",
              )}
            >
              {t(`statuses.${alert.status}`)}
            </span>
          </dd>
          <dt className="text-muted-foreground">{t("condition")}</dt>
          <dd>
            {alert.condition === "below_price" && alert.threshold != null
              ? t("belowPrice", { price: money(alert.threshold) })
              : t("belowTypical")}
          </dd>
          <dt className="text-muted-foreground">{t("channel")}</dt>
          <dd>{t(`channels.${alert.channel}`)}</dd>
          <dt className="text-muted-foreground">{t("lastCheck")}</dt>
          <dd className="flex items-center gap-1.5">
            <Clock className="text-muted-foreground size-3.5" aria-hidden />
            {alert.last_checked_at
              ? t("lastCheckValue", {
                  when: format.dateTime(new Date(alert.last_checked_at), {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                  price: alert.last_price != null ? money(alert.last_price) : "—",
                })
              : t("notChecked")}
          </dd>
          {alert.last_notified_price != null && (
            <>
              <dt className="text-muted-foreground">{t("lastNotified")}</dt>
              <dd>{money(alert.last_notified_price)}</dd>
            </>
          )}
        </dl>

        {telegramLink && (
          <div className="bg-accent/60 grid gap-2 rounded-lg p-3 text-sm">
            <p>{t("telegramPending")}</p>
            <a
              href={telegramLink}
              target="_blank"
              rel="noopener noreferrer"
              className="bg-primary text-primary-foreground hover:bg-primary/90 flex w-fit items-center gap-2 rounded-lg px-4 py-2 font-medium transition-colors"
            >
              <Send className="size-4" aria-hidden />
              {t("openTelegram")}
            </a>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 border-t pt-4">
          <Link
            href={`/?${search}`}
            className="text-primary text-sm font-medium underline-offset-4 hover:underline"
          >
            {t("openSearch")}
          </Link>
          <div className="ml-auto flex flex-wrap gap-2">
            {alert.channel === "email" && alert.status === "pending" && (
              <ActionForm token={token} action="confirm">
                <Button type="submit" className="shadow-primary/25 shadow-md">
                  <CheckCircle2 className="size-4" aria-hidden />
                  {t("confirm")}
                </Button>
              </ActionForm>
            )}
            {active && (
              <ActionForm token={token} action="stop">
                <Button
                  type="submit"
                  variant="outline"
                  className="hover:border-destructive/50 hover:text-destructive"
                >
                  <BellOff className="size-4" aria-hidden />
                  {t("stop")}
                </Button>
              </ActionForm>
            )}
          </div>
        </div>
        <p className="text-muted-foreground text-[11px]">{t("privacy")}</p>
      </CardContent>
    </Card>
  );
}

function ActionForm({
  token,
  action,
  children,
}: {
  token: string;
  action: "confirm" | "stop";
  children: React.ReactNode;
}) {
  return (
    <form method="post" action="/api/alerts/action">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="action" value={action} />
      {children}
    </form>
  );
}
