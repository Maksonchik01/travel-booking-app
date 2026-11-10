"use client";

import { Pencil, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";

import { Button } from "@/components/ui/button";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";

/**
 * На сторінці результатів форма згорнута в рядок «що шукаємо» (напр. «WAW → LIS · 5–12 груд. ·
 * 1 дорослий») з кнопкою «Змінити» — на всіх екранах (модуль 23c): головне — результати, а не
 * форма на пів екрана. Без JS форма відкрита.
 */
export function CollapsibleSearch({
  title,
  details,
  children,
}: {
  title: string;
  details: string;
  children: ReactNode;
}) {
  const t = useTranslations("search");
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);
  const collapsed = hydrated && !open;

  return (
    <div className="grid gap-4">
      {hydrated && (
        <div className="flex items-center justify-between gap-3" data-testid="search-summary">
          <div className="min-w-0">
            <p className="truncate font-semibold sm:text-lg">{title}</p>
            <p className="text-muted-foreground truncate text-xs sm:text-sm">{details}</p>
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
      <div className={cn(collapsed && "hidden")}>{children}</div>
    </div>
  );
}
