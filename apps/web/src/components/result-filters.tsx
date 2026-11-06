"use client";

import type { AirlineFacet, OfferFilters } from "@tickets/shared";
import { SlidersHorizontal } from "lucide-react";
import Form from "next/form";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import { FormPendingNote } from "@/components/pending";
import { Button } from "@/components/ui/button";
import {
  DEPARTURE_PERIODS,
  filterParams,
  MAX_DURATION_OPTIONS,
  MAX_STOPS_OPTIONS,
} from "@/lib/search-params";
import { SELECT_CLASS } from "@/lib/styles";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";

type Props = {
  filters: OfferFilters;
  airlines: AirlineFacet[];
  /** Решта стану пошуку (маршрут, дати, сортування) — щоб фільтр його не губив. */
  baseParams: [string, string][];
};

/**
 * Фільтри видачі. Звичайна GET-форма: працює без JS (кнопка «Застосувати»),
 * з JS застосовується одразу при зміні. Нового запиту до провайдерів не робить —
 * пошук береться з кешу, фільтрує бекенд.
 */
export function ResultFilters({ filters, airlines, baseParams }: Props) {
  const t = useTranslations("filters");
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);
  const activeCount = filterParams(filters).length;
  const resetHref = `/?${new URLSearchParams(baseParams)}`;

  // Обрані авіакомпанії, яких немає у видачі, теж показуємо — щоб їх можна було зняти.
  const known = new Set(airlines.map((a) => a.code));
  const airlineOptions = [
    ...airlines,
    ...(filters.airlines ?? [])
      .filter((code) => !known.has(code))
      .map((code) => ({ code, name: null, offers: 0 })),
  ];

  return (
    <aside
      className="bg-card grid content-start gap-4 rounded-xl border p-4 shadow-xs lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto"
      aria-labelledby="filters-title"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="filters-title" className="flex items-center gap-2 font-semibold">
          <SlidersHorizontal className="text-primary size-4" aria-hidden />
          {t("title")}
        </h2>
        {hydrated && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="hover:border-primary/50 hover:text-primary lg:hidden"
            aria-expanded={open}
            aria-controls="filters-panel"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? t("hide") : t("show", { count: activeCount })}
          </Button>
        )}
      </div>

      <Form
        action="/"
        id="filters-panel"
        className={cn("grid gap-5 text-sm", hydrated && !open && "hidden lg:grid")}
        onChange={(e) => e.currentTarget.requestSubmit()}
      >
        {baseParams.map(([key, value]) => (
          <input key={`${key}=${value}`} type="hidden" name={key} value={value} />
        ))}

        <Group legend={t("stops")}>
          <Choice name="stops" value="" checked={filters.max_stops == null} label={t("anyStops")} />
          {MAX_STOPS_OPTIONS.map((n) => (
            <Choice
              key={n}
              name="stops"
              value={String(n)}
              checked={filters.max_stops === n}
              label={t("maxStops", { count: n })}
            />
          ))}
        </Group>

        <Group legend={t("departure")}>
          {DEPARTURE_PERIODS.map((period) => (
            <Choice
              key={period}
              type="checkbox"
              name="dep"
              value={period}
              checked={filters.departure_periods?.includes(period) ?? false}
              label={t(`period.${period}`)}
            />
          ))}
        </Group>

        <label className="grid gap-1.5">
          <span className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
            {t("maxDuration")}
          </span>
          <select
            name="maxh"
            defaultValue={filters.max_duration_hours ?? ""}
            className={cn(SELECT_CLASS, "h-9")}
          >
            <option value="">{t("anyDuration")}</option>
            {MAX_DURATION_OPTIONS.map((h) => (
              <option key={h} value={h}>
                {t("upToHours", { hours: h })}
              </option>
            ))}
          </select>
        </label>

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
            placeholder={t("anyPrice")}
            defaultValue={filters.max_price ?? ""}
            // Число застосовуємо після введення, а не на кожну цифру.
            onChange={(e) => e.stopPropagation()}
            onBlur={(e) => e.currentTarget.form?.requestSubmit()}
            className={cn(SELECT_CLASS, "h-9 cursor-text")}
          />
        </label>

        {airlineOptions.length > 1 && (
          <Group legend={t("airlines")} hint={t("airlinesHint")}>
            {airlineOptions.map((a) => (
              <Choice
                key={a.code}
                type="checkbox"
                name="al"
                value={a.code}
                checked={filters.airlines?.includes(a.code) ?? false}
                label={a.name ?? a.code}
                count={a.offers}
              />
            ))}
          </Group>
        )}

        <FormPendingNote label={t("updating")} className="min-h-4" />

        <div className="flex items-center gap-3">
          {!hydrated && (
            <Button type="submit" size="sm">
              {t("apply")}
            </Button>
          )}
          {activeCount > 0 && (
            <Link
              href={resetHref}
              className="text-primary rounded text-xs font-medium underline-offset-4 hover:underline"
            >
              {t("reset")}
            </Link>
          )}
        </div>
      </Form>
    </aside>
  );
}

function Group({
  legend,
  hint,
  children,
}: {
  legend: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="grid gap-0.5">
      <legend className="text-muted-foreground mb-1.5 text-xs font-semibold tracking-wide uppercase">
        {legend}
      </legend>
      {children}
      {hint && <p className="text-muted-foreground text-[11px]">{hint}</p>}
    </fieldset>
  );
}

function Choice({
  type = "radio",
  name,
  value,
  checked,
  label,
  count,
}: {
  type?: "radio" | "checkbox";
  name: string;
  value: string;
  checked: boolean;
  label: string;
  count?: number;
}) {
  return (
    <label className="hover:bg-accent has-[:checked]:text-primary -mx-2 flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors has-[:checked]:font-medium">
      <input
        type={type}
        name={name}
        value={value}
        defaultChecked={checked}
        className="accent-primary size-4"
      />
      <span className="flex-1">{label}</span>
      {count != null && <span className="text-muted-foreground text-xs tabular-nums">{count}</span>}
    </label>
  );
}
