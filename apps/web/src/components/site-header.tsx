import { PlaneTakeoff } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

export function SiteHeader({ active }: { active: "flights" | "stays" }) {
  const t = useTranslations("nav");
  return (
    <header className="bg-background/75 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-40 border-b backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-6 px-4">
        <Link
          href="/"
          className="group flex items-center gap-2 rounded-md font-semibold tracking-tight"
        >
          <span className="from-primary grid size-8 place-items-center rounded-lg bg-gradient-to-br to-sky-500 text-white shadow-md shadow-primary/30 transition-transform group-hover:-rotate-6">
            <PlaneTakeoff className="size-4" aria-hidden />
          </span>
          {t("brand")}
        </Link>
        <nav className="text-muted-foreground flex items-center gap-1 text-sm">
          {(["flights", "stays"] as const).map((section) => (
            <Link
              key={section}
              href={section === "flights" ? "/" : "/stays"}
              aria-current={active === section ? "page" : undefined}
              className={cn(
                "rounded-md px-3 py-1.5 font-medium transition-colors",
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
