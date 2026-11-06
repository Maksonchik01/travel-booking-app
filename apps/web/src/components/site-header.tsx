import { PlaneTakeoff } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

const SECTIONS = { flights: "/", stays: "/stays", trip: "/trip" } as const;

export function SiteHeader({ active }: { active: keyof typeof SECTIONS }) {
  const t = useTranslations("nav");
  return (
    <header className="bg-background/75 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-40 border-b backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 sm:gap-6">
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
        <nav className="text-muted-foreground -mx-1 flex items-center gap-1 overflow-x-auto px-1 text-sm">
          {(Object.keys(SECTIONS) as (keyof typeof SECTIONS)[]).map((section) => (
            <Link
              key={section}
              href={SECTIONS[section]}
              aria-current={active === section ? "page" : undefined}
              className={cn(
                "shrink-0 rounded-md px-2.5 py-1.5 font-medium transition-colors sm:px-3",
                active === section
                  ? "bg-accent text-accent-foreground"
                  : "hover:text-foreground hover:bg-muted",
              )}
            >
              {t(section)}
            </Link>
          ))}
        </nav>
        <ThemeToggle className="ml-auto" />
      </div>
    </header>
  );
}
