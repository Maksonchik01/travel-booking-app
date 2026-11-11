"use client";

import { Pencil, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * На сторінці результатів форма згорнута в рядок «що шукаємо» (напр. «WAW → LIS · 5–12 груд. ·
 * 1 дорослий») з «Змінити» — на всіх екранах (модуль 23c): головне — результати, а не форма на
 * пів екрана.
 *
 * Нативний `<details>` (V3, етап 9): згорнутий уже в HTML сервера — гідратація не змінює
 * розмітку, тож результати не «підскакують» (раніше форма згорталась лише після JS: CLS до
 * 0,18). Без JS розгортається так само, кліком на рядок.
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
  const [open, setOpen] = useState(false);

  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="group">
      <summary
        className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden"
        data-testid="search-summary"
      >
        <span className="grid min-w-0">
          <span className="truncate font-semibold sm:text-lg">{title}</span>
          <span className="text-muted-foreground truncate text-xs sm:text-sm">{details}</span>
        </span>
        <span
          aria-hidden
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "group-hover:border-primary/50 group-hover:text-primary shrink-0",
          )}
        >
          {open ? <X className="size-3.5" /> : <Pencil className="size-3.5" />}
          {open ? t("collapse") : t("edit")}
        </span>
        <span className="sr-only">{open ? t("collapse") : t("edit")}</span>
      </summary>
      <div className="pt-4">{children}</div>
    </details>
  );
}
