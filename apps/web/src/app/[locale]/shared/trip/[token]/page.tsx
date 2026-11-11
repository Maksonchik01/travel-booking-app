import type { SharedTrip } from "@tickets/shared";
import { BedDouble, Link2Off, Plane } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { Suspense } from "react";

import { HeroBackdrop, SiteFooter } from "@/components/page-chrome";
import { SiteHeader } from "@/components/site-header";
import { Card, CardContent } from "@/components/ui/card";
import { PageNotice } from "@/components/page-notice";
import { fetchSharedTrip } from "@/lib/api";
import { localDate, localTime } from "@/lib/format";
import { fractionDigits } from "@/lib/money";
import { toTripParams } from "@/lib/trip-params";

/** Публічне посилання — не для пошукових систем (модуль 20.2). */
export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * Публічний перегляд поїздки (модуль 20.2): лише сама поїздка з цінами на момент збереження.
 * Без власника, назви, бюджету й власних витрат — їх API сюди й не віддає.
 */
export default function SharedTripPage({ params }: PageProps<"/[locale]/shared/trip/[token]">) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <SiteHeader active="trip" />
      <main id="main" tabIndex={-1} className="outline-none relative isolate flex-1">
        <HeroBackdrop />
        <div className="mx-auto grid w-full max-w-2xl gap-5 px-4 py-8 sm:py-12">
          <Suspense fallback={<div className="shimmer h-64 rounded-xl" />}>
            <Shared params={params} />
          </Suspense>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

async function Shared({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = /^[A-Za-z0-9_-]{16,40}$/.test(token) ? await fetchSharedTrip(token) : null;
  if (!result || (!result.ok && result.reason === "not_found")) return <NotFound />;
  // Збій сервера — не «посилання вимкнено»: посилання робоче, повторіть пізніше (V3, етап 7).
  if (!result.ok) return <Unavailable token={token} />;
  return <TripView trip={result.data} />;
}

function Unavailable({ token }: { token: string }) {
  const t = useTranslations("sharedTrip");
  return (
    <PageNotice tone="error" retryHref={`/shared/trip/${token}`}>
      {t("unavailable")}
    </PageNotice>
  );
}

function NotFound() {
  const t = useTranslations("sharedTrip");
  return (
    <Card className="py-0">
      <CardContent className="grid gap-2 p-6 text-center">
        <Link2Off className="text-muted-foreground mx-auto size-8" aria-hidden />
        <h1 className="text-lg font-semibold" data-testid="shared-trip-missing">
          {t("notFound")}
        </h1>
      </CardContent>
    </Card>
  );
}

function TripView({ trip }: { trip: SharedTrip }) {
  const t = useTranslations("sharedTrip");
  const format = useFormatter();
  const s = trip.snapshot;
  const money = (value: number | string) =>
    format.number(Number(value), {
      style: "currency",
      currency: s.currency,
      currencyDisplay: "narrowSymbol",
      ...fractionDigits(value),
    });
  const day = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  const at = (iso: string) => `${day(localDate(iso))}, ${localTime(iso)}`;
  return (
    <Card
      className="border-primary/10 shadow-primary/[0.07] py-0 shadow-xl"
      data-testid="shared-trip"
    >
      <CardContent className="grid gap-5 p-5 sm:p-6">
        <div className="grid gap-1">
          <h1 className="text-2xl font-bold tracking-tight">
            {t("title", { from: s.flight.origin, to: s.flight.destination })}
          </h1>
          <p className="text-muted-foreground text-sm">
            {day(s.check_in)} – {day(s.check_out)} · {t("nights", { count: s.nights })}
          </p>
        </div>
        <div className="flex items-baseline justify-between gap-3 border-y py-3">
          <span className="text-sm font-medium">{t("total")}</span>
          <span className="text-2xl font-bold tabular-nums" data-testid="shared-trip-total">
            {money(s.money_total)}
          </span>
        </div>
        <dl className="grid gap-3 text-sm">
          <div className="flex items-start gap-2">
            <Plane className="text-primary mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="grid gap-0.5">
              <dt className="font-medium">{t("flight")}</dt>
              <dd className="text-muted-foreground">
                {at(s.flight.departure_at)} → {at(s.flight.return_departure_at)} ·{" "}
                {t("stops", { count: s.flight.stops })} · {s.flight.airlines.join(", ")} ·{" "}
                {money(s.flight.price)}
              </dd>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <BedDouble className="text-primary mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="grid gap-0.5">
              <dt className="font-medium">{t("stay")}</dt>
              <dd className="text-muted-foreground">
                {s.stay.name}
                {s.stay.rating != null &&
                  ` · ${t("rating", { rating: format.number(s.stay.rating, { maximumFractionDigits: 1 }) })}`}{" "}
                · {money(s.stay.total_price)}
              </dd>
            </div>
          </div>
        </dl>
        <p className="text-muted-foreground text-xs">
          {t("pricesAt", { date: day(localDate(s.priced_at)) })}
        </p>
        <Link
          href={`/trip?${toTripParams(trip.query)}`}
          className="bg-primary text-primary-foreground hover:bg-(--primary-hover) w-fit rounded-full px-4 py-2 text-sm font-medium"
          data-testid="shared-trip-open"
        >
          {t("openPlanner")}
        </Link>
      </CardContent>
    </Card>
  );
}
