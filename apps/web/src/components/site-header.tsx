import { Heart, Luggage, PlaneTakeoff } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Suspense } from "react";

import { LanguageSwitcher } from "@/components/language-switcher";
import { SectionLink } from "@/components/section-link";
import { ThemeToggle } from "@/components/theme-toggle";
import { UserMenu } from "@/components/user-menu";
import { cn } from "@/lib/utils";

const SECTIONS = { flights: "/", stays: "/stays", trip: "/trip" } as const;

export function SiteHeader({ active }: { active: keyof typeof SECTIONS | null }) {
  const t = useTranslations("nav");
  return (
    <header className="bg-background/75 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-40 border-b backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-2 px-4 sm:gap-6">
        <Link
          href="/"
          aria-label={t("brand")}
          className="group flex shrink-0 items-center gap-2 rounded-md font-semibold tracking-tight"
        >
          <span className="from-primary grid size-8 place-items-center rounded-lg bg-gradient-to-br to-sky-500 text-white shadow-md shadow-primary/30 transition-transform group-hover:-rotate-6">
            <PlaneTakeoff className="size-4" aria-hidden />
          </span>
          <span className="hidden sm:inline">{t("brand")}</span>
        </Link>
        <nav
          aria-label={t("sectionsLabel")}
          className="text-muted-foreground -mx-1 hidden min-w-0 items-center gap-0.5 overflow-x-auto px-1 text-[13px] sm:flex sm:gap-1 sm:text-sm"
        >
          {(Object.keys(SECTIONS) as (keyof typeof SECTIONS)[]).map((section) => (
            <SectionLink
              key={section}
              section={section}
              href={SECTIONS[section]}
              aria-current={active === section ? "page" : undefined}
              className={cn(
                "shrink-0 rounded-md px-2 py-1.5 font-medium transition-colors sm:px-3",
                active === section
                  ? "bg-accent text-accent-foreground"
                  : "hover:text-foreground hover:bg-muted",
              )}
            >
              {t(section)}
            </SectionLink>
          ))}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
          {/* На телефоні місця для розділів замало — «Обране» й «Мої поїздки» там у футері. */}
          <Link
            href="/trips"
            aria-label={t("trips")}
            title={t("trips")}
            className="text-muted-foreground hover:text-foreground hover:bg-muted hidden size-9 place-items-center rounded-lg transition-colors sm:grid"
          >
            <Luggage className="size-4" aria-hidden />
          </Link>
          <Link
            href="/favorites"
            aria-label={t("favorites")}
            title={t("favorites")}
            className="text-muted-foreground hover:text-foreground hover:bg-muted hidden size-9 place-items-center rounded-lg transition-colors sm:grid"
          >
            <Heart className="size-4" aria-hidden />
          </Link>
          <LanguageSwitcher />
          <ThemeToggle />
          {/* Сесія читається під час запиту — окремо від статичної шапки. */}
          <Suspense fallback={<span className="bg-muted h-9 w-20 animate-pulse rounded-lg" />}>
            <UserMenu />
          </Suspense>
        </div>
      </div>
    </header>
  );
}
