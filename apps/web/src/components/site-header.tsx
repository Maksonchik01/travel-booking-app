import { PlaneTakeoff } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

export function SiteHeader() {
  const t = useTranslations("nav");
  return (
    <header className="border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-6 px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="bg-primary text-primary-foreground grid size-7 place-items-center rounded-md">
            <PlaneTakeoff className="size-4" aria-hidden />
          </span>
          {t("brand")}
        </Link>
        <nav className="text-muted-foreground flex items-center gap-4 text-sm">
          <Link href="/" className="text-foreground font-medium">
            {t("flights")}
          </Link>
          <span aria-disabled className="cursor-not-allowed opacity-60">
            {t("stays")}{" "}
            <span className="bg-muted rounded px-1.5 py-0.5 text-[10px] uppercase">
              {t("staysSoon")}
            </span>
          </span>
        </nav>
      </div>
    </header>
  );
}
