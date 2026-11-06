"use client";

import { Pencil, Plane, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";

import { Button } from "@/components/ui/button";
import type { SearchState } from "@/lib/search-params";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";

/**
 * На мобільному на сторінці результатів форма займає весь екран, тож згортаємо її в рядок
 * «WAW → LIS · 5–12 груд. · 1 дорослий» з кнопкою «Змінити». На ширших екранах і без JS
 * форма завжди відкрита.
 */
export function CollapsibleSearch({
  state,
  children,
}: {
  state: SearchState;
  children: ReactNode;
}) {
  const t = useTranslations("search");
  const format = useFormatter();
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);
  const { query } = state;
  const date = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  const dates = query.return_date
    ? `${date(query.departure_date)} – ${date(query.return_date)}`
    : date(query.departure_date);
  const collapsed = hydrated && !open;

  return (
    <div className="grid gap-4">
      {hydrated && (
        <div className="flex items-center justify-between gap-3 sm:hidden">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 font-semibold">
              {query.origin}
              <Plane className="text-primary size-3.5" aria-hidden />
              {query.destination}
            </p>
            <p className="text-muted-foreground truncate text-xs">
              {dates} · {t("adultsCount", { count: query.passengers.adults })}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="hover:border-primary/50 hover:text-primary shrink-0"
          >
            {open ? (
              <X className="size-3.5" aria-hidden />
            ) : (
              <Pencil className="size-3.5" aria-hidden />
            )}
            {open ? t("collapse") : t("edit")}
          </Button>
        </div>
      )}
      <div className={cn(collapsed && "hidden sm:block")}>{children}</div>
    </div>
  );
}
