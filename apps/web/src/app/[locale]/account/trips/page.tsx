import { useTranslations } from "next-intl";

import { AccountPage, Section } from "@/components/account-shell";
import { SavedTripsList, SavedTripsProvider } from "@/components/saved-trips";
import { TripCompareBar, TripCompareProvider } from "@/components/trip-compare";

/** Кабінет → «Мої поїздки»: збережені поїздки зі статусами (той самий список, що й на /trips). */
export default function AccountTripsPage({ searchParams }: PageProps<"/[locale]/account/trips">) {
  return (
    <AccountPage section="trips" searchParams={searchParams}>
      <Trips />
    </AccountPage>
  );
}

function Trips() {
  const t = useTranslations("savedTrips");
  return (
    <Section id="trips" title={t("pageTitle")} hint={t("subtitle")}>
      <SavedTripsProvider>
        <TripCompareProvider>
          <SavedTripsList />
          <TripCompareBar />
        </TripCompareProvider>
      </SavedTripsProvider>
    </Section>
  );
}
