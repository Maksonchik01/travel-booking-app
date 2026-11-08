import type { Metadata } from "next";
import { Luggage } from "lucide-react";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";

import { SiteFooter } from "@/components/page-chrome";
import { SavedTripsList, SavedTripsProvider } from "@/components/saved-trips";
import { SiteHeader } from "@/components/site-header";
import { TripCompareBar, TripCompareProvider } from "@/components/trip-compare";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("savedTrips");
  return { title: t("pageTitle") };
}

/** «Мої поїздки» (модуль 8c): акаунт або цей браузер — список будує клієнт. */
export default function SavedTripsPage() {
  const t = useTranslations("savedTrips");
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <SiteHeader active={null} />
      <main className="mx-auto grid w-full max-w-4xl flex-1 content-start gap-6 px-4 py-8 pb-24">
        <div className="grid gap-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Luggage className="text-primary size-5" aria-hidden />
            {t("pageTitle")}
          </h1>
          <p className="text-muted-foreground text-sm">{t("subtitle")}</p>
        </div>
        <SavedTripsProvider>
          <TripCompareProvider>
            <SavedTripsList />
            <TripCompareBar />
          </TripCompareProvider>
        </SavedTripsProvider>
      </main>
      <SiteFooter />
    </div>
  );
}
