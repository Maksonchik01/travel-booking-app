import type { Metadata } from "next";
import { Heart } from "lucide-react";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";

import { FavoritesList, FavoritesProvider } from "@/components/favorites";
import { GuestSearches } from "@/components/guest-searches";
import { SiteFooter } from "@/components/page-chrome";
import { SiteHeader } from "@/components/site-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("favorites");
  return { title: t("title") };
}

/** Обране (модуль 7): акаунт або цей браузер — список будує клієнт. */
export default function FavoritesPage() {
  const t = useTranslations("favorites");
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <SiteHeader active={null} />
      <main
        id="main"
        tabIndex={-1}
        className="outline-none mx-auto grid w-full max-w-4xl flex-1 content-start gap-6 px-4 py-8"
      >
        <div className="grid gap-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Heart className="size-5 fill-rose-500 text-rose-500" aria-hidden />
            {t("title")}
          </h1>
          <p className="text-muted-foreground text-sm">{t("subtitle")}</p>
        </div>
        <FavoritesProvider>
          <FavoritesList />
        </FavoritesProvider>
        <GuestSearches />
      </main>
      <SiteFooter />
    </div>
  );
}
