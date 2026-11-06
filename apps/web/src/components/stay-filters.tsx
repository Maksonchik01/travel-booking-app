"use client";

import type { StayFacets, StayFilters as Filters } from "@tickets/shared";
import { SlidersHorizontal } from "lucide-react";
import Form from "next/form";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import { FormPendingNote } from "@/components/pending";
import { Choice, Group } from "@/components/result-filters";
import { Button } from "@/components/ui/button";
import { MIN_RATING_OPTIONS, stayFilterParams } from "@/lib/stay-params";
import { SELECT_CLASS } from "@/lib/styles";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";

type Props = {
  filters: Filters;
  facets: StayFacets;
  /** Решта стану пошуку (місто, дати, сортування) — щоб фільтр його не губив. */
  baseParams: [string, string][];
};

/**
 * Фільтри житла: GET-форма (без JS — кнопка «Застосувати»), з JS застосовується одразу.
 * Нового запиту до провайдерів не робить — фільтрує бекенд після них.
 */
export function StayFilters({ filters, facets, baseParams }: Props) {
  const t = useTranslations("stayFilters");
  const tKind = useTranslations("stayCard.kind");
  const tShared = useTranslations("filters");
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);
  const activeCount = stayFilterParams(filters).length;
  const resetHref = `/stays?${new URLSearchParams(baseParams)}`;

  return (
    <aside
      className="bg-card grid content-start gap-4 rounded-xl border p-4 shadow-xs lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto"
      aria-labelledby="stay-filters-title"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="stay-filters-title" className="flex items-center gap-2 font-semibold">
          <SlidersHorizontal className="text-primary size-4" aria-hidden />
          {tShared("title")}
        </h2>
        {hydrated && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="hover:border-primary/50 hover:text-primary lg:hidden"
            aria-expanded={open}
            aria-controls="stay-filters-panel"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? tShared("hide") : tShared("show", { count: activeCount })}
          </Button>
        )}
      </div>

      <Form
        action="/stays"
        id="stay-filters-panel"
        className={cn("grid gap-5 text-sm", hydrated && !open && "hidden lg:grid")}
        onChange={(e) => e.currentTarget.requestSubmit()}
      >
        {baseParams.map(([key, value]) => (
          <input key={`${key}=${value}`} type="hidden" name={key} value={value} />
        ))}

        <label className="grid gap-1.5">
          <span className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
            {t("maxPrice")}
          </span>
          <input
            type="number"
            name="maxp"
            min={1}
            step={1}
            inputMode="numeric"
            placeholder={tShared("anyPrice")}
            defaultValue={filters.max_price_per_night ?? ""}
            // Число застосовуємо після введення, а не на кожну цифру.
            onChange={(e) => e.stopPropagation()}
            onBlur={(e) => e.currentTarget.form?.requestSubmit()}
            className={cn(SELECT_CLASS, "h-9 cursor-text")}
          />
        </label>

        <Group legend={t("rating")}>
          <Choice
            name="rating"
            value=""
            checked={filters.min_rating == null}
            label={t("anyRating")}
          />
          {MIN_RATING_OPTIONS.map((r) => (
            <Choice
              key={r}
              name="rating"
              value={String(r)}
              checked={filters.min_rating === r}
              label={t("ratingFrom", { rating: r })}
            />
          ))}
        </Group>

        <Group legend={t("cancellation")}>
          <Choice
            type="checkbox"
            name="cancel"
            value="1"
            checked={filters.free_cancellation ?? false}
            label={t("freeCancellation")}
          />
        </Group>

        {facets.kinds.length > 1 && (
          <Group legend={t("kind")} hint={t("kindHint")}>
            {facets.kinds.map((k) => (
              <Choice
                key={k.kind}
                type="checkbox"
                name="kind"
                value={k.kind}
                checked={filters.kinds?.includes(k.kind) ?? false}
                label={tKind(k.kind)}
                count={k.stays}
              />
            ))}
          </Group>
        )}

        <FormPendingNote label={tShared("updating")} className="min-h-4" />

        <div className="flex items-center gap-3">
          {!hydrated && (
            <Button type="submit" size="sm">
              {tShared("apply")}
            </Button>
          )}
          {activeCount > 0 && (
            <Link
              href={resetHref}
              className="text-primary rounded text-xs font-medium underline-offset-4 hover:underline"
            >
              {tShared("reset")}
            </Link>
          )}
        </div>
      </Form>
    </aside>
  );
}
