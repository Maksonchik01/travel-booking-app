import { useTranslations } from "next-intl";

import { AccountPage, Section } from "@/components/account-shell";
import { FavoritesList, FavoritesProvider } from "@/components/favorites";

/** Кабінет → «Обране»: квитки, житло, поїздки (той самий список, що й на /favorites). */
export default function AccountFavoritesPage({
  searchParams,
}: PageProps<"/[locale]/account/favorites">) {
  return (
    <AccountPage section="favorites" searchParams={searchParams}>
      <Favorites />
    </AccountPage>
  );
}

function Favorites() {
  const t = useTranslations("favorites");
  return (
    <Section id="favorites" title={t("title")} hint={t("subtitle")}>
      <FavoritesProvider>
        <FavoritesList />
      </FavoritesProvider>
    </Section>
  );
}
