"use client";

import type { AirlineFacet, DeparturePeriod, HourRange, OfferFilters } from "@tickets/shared";
import { ChevronDown, Loader2, SlidersHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { saveFlightFilters } from "@/app/actions/account";
import { Button } from "@/components/ui/button";
import { pickFilters, writeLocalFilters } from "@/lib/saved-filters";
import {
  DEPARTURE_PERIODS,
  filterParams,
  MAX_DURATION_OPTIONS,
  MAX_LAYOVER_OPTIONS,
  MAX_STOPS_OPTIONS,
  MIN_LAYOVER_OPTIONS,
  MIN_SELF_TRANSFER_OPTIONS,
  parseSearchParams,
  toSearchParams,
} from "@/lib/search-params";
import { SELECT_CLASS } from "@/lib/styles";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";

type Props = {
  filters: OfferFilters;
  airlines: AirlineFacet[];
  /** Решта стану пошуку (маршрут, дати, сортування) — щоб фільтр його не губив. */
  baseParams: [string, string][];
  /** Туди й назад — показуємо ще час вильоту й прильоту назад. */
  roundTrip?: boolean;
  /** Валюта пошуку — для підписів бюджету. */
  currency?: string;
};

/** Ключі URL, що живуть у «Розширених фільтрах» (решта — на виду). */
const ADVANCED_KEYS = new Set([
  "arr",
  "arrh",
  "rdep",
  "rdeph",
  "rarr",
  "rarrh",
  "maxlay",
  "minlay",
  "minself",
  "al",
  "xal",
]);

/**
 * Фільтри видачі (модуль 1d ТЗ). Основні — на виду, решта — у «Розширених фільтрах» з
 * лічильником. Звичайна GET-форма: без JS працює кнопка «Застосувати»; з JS зміни
 * застосовуються одразу, а адреса збирається без порожніх полів. Нового запиту до
 * провайдерів не робить — фільтрує бекенд по вже отриманих цінах.
 */
export function ResultFilters({
  filters,
  airlines,
  baseParams,
  roundTrip = false,
  currency = "EUR",
}: Props) {
  const t = useTranslations("filters");
  const hydrated = useHydrated();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [savedNote, setSavedNote] = useState<"account" | "browser" | null>(null);
  const active = filterParams(filters);
  const activeCount = active.length;
  const advancedCount = active.filter(([key]) => ADVANCED_KEYS.has(key)).length;
  const resetHref = `/?${new URLSearchParams(baseParams)}`;

  // Обрані авіакомпанії, яких немає у видачі, теж показуємо — щоб їх можна було зняти.
  const known = new Set(airlines.map((a) => a.code));
  const missing = (codes: string[] | undefined) =>
    (codes ?? [])
      .filter((code) => !known.has(code))
      .map((code) => ({ code, name: null, offers: 0 }));
  const airlineOptions = [...airlines, ...missing(filters.airlines)];
  const excludeOptions = [...airlines, ...missing(filters.excluded_airlines)];

  function apply(event: React.FormEvent<HTMLFormElement>) {
    // Без JS форма йде звичайним GET; з JS — чиста адреса без порожніх полів.
    event.preventDefault();
    const raw: Record<string, string[]> = {};
    for (const [key, value] of new FormData(event.currentTarget)) {
      if (typeof value === "string" && value !== "") (raw[key] ??= []).push(value);
    }
    const state = parseSearchParams(raw);
    startTransition(() =>
      router.push(state ? `/?${toSearchParams(state)}` : resetHref, { scroll: false }),
    );
  }

  async function save() {
    const value = pickFilters(active);
    writeLocalFilters(value);
    const result = await saveFlightFilters(value || null);
    setSavedNote(result.saved ? "account" : "browser");
  }

  return (
    <aside
      className="bg-card grid content-start gap-4 rounded-xl border p-4 shadow-xs lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto"
      aria-labelledby="filters-title"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="filters-title" className="flex items-center gap-2 font-semibold">
          <SlidersHorizontal className="text-primary size-4" aria-hidden />
          {t("title")}
          {activeCount > 0 && (
            <span
              className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-xs font-medium tabular-nums"
              data-testid="filters-count"
            >
              {activeCount}
            </span>
          )}
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

      <form
        action="/"
        method="get"
        id="filters-panel"
        className={cn("grid gap-5 text-sm", hydrated && !open && "hidden lg:grid")}
        onSubmit={apply}
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

        <TimeGroup
          legend={t("departure")}
          name="dep"
          periods={filters.departure_periods}
          hours={filters.departure_hours}
        />

        <OptionSelect
          label={t("maxDuration")}
          name="maxh"
          value={filters.max_duration_hours}
          options={MAX_DURATION_OPTIONS}
          any={t("anyDuration")}
          format={(h) => t("upToHours", { hours: h })}
        />

        <NumberField
          label={t("maxPrice", { currency })}
          name="maxp"
          value={filters.max_price}
          placeholder={t("anyPrice")}
        />
        <NumberField
          label={t("maxTotalPrice", { currency })}
          name="maxt"
          value={filters.max_total_price}
          placeholder={t("anyPrice")}
        />

        <details className="group grid gap-5" open={advancedCount > 0}>
          <summary className="text-primary flex cursor-pointer list-none items-center gap-1.5 text-xs font-semibold tracking-wide uppercase [&::-webkit-details-marker]:hidden">
            {t("advanced")}
            {advancedCount > 0 && (
              <span className="tabular-nums" data-testid="advanced-count">
                ({advancedCount})
              </span>
            )}
            <ChevronDown
              className="size-3.5 transition-transform group-open:rotate-180"
              aria-hidden
            />
          </summary>
          <div className="mt-4 grid gap-5">
            <TimeGroup
              legend={t("arrival")}
              name="arr"
              periods={filters.arrival_periods}
              hours={filters.arrival_hours}
            />
            {roundTrip && (
              <>
                <TimeGroup
                  legend={t("returnDeparture")}
                  name="rdep"
                  periods={filters.return_departure_periods}
                  hours={filters.return_departure_hours}
                />
                <TimeGroup
                  legend={t("returnArrival")}
                  name="rarr"
                  periods={filters.return_arrival_periods}
                  hours={filters.return_arrival_hours}
                />
              </>
            )}
            <OptionSelect
              label={t("maxLayover")}
              name="maxlay"
              value={filters.max_layover_hours}
              options={MAX_LAYOVER_OPTIONS}
              any={t("anyDuration")}
              format={(h) => t("upToHours", { hours: h })}
            />
            <OptionSelect
              label={t("minLayover")}
              name="minlay"
              value={filters.min_layover_min}
              options={MIN_LAYOVER_OPTIONS}
              any={t("anyDuration")}
              format={(m) => t("fromMinutes", { minutes: m })}
            />
            <OptionSelect
              label={t("minSelfTransfer")}
              hint={t("minSelfTransferHint")}
              name="minself"
              value={filters.min_self_transfer_min}
              options={MIN_SELF_TRANSFER_OPTIONS}
              any={t("anyDuration")}
              format={(m) => t("fromHours", { hours: m / 60 })}
            />
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
            {excludeOptions.length > 0 && (
              <Group legend={t("excludeAirlines")} hint={t("excludeAirlinesHint")}>
                {excludeOptions.map((a) => (
                  <Choice
                    key={a.code}
                    type="checkbox"
                    name="xal"
                    value={a.code}
                    checked={filters.excluded_airlines?.includes(a.code) ?? false}
                    label={a.name ?? a.code}
                  />
                ))}
              </Group>
            )}
          </div>
        </details>

        <p
          role="status"
          className="text-muted-foreground flex min-h-4 items-center gap-1.5 text-xs"
        >
          {pending && (
            <>
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              {t("updating")}
            </>
          )}
          {!pending && savedNote && t(savedNote === "account" ? "savedAccount" : "savedBrowser")}
        </p>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button type="submit" size="sm">
            {t("apply")}
          </Button>
          {activeCount > 0 && (
            <Link
              href={resetHref}
              className="text-primary rounded text-xs font-medium underline-offset-4 hover:underline"
            >
              {t("reset")}
            </Link>
          )}
          {hydrated && (
            <Button type="button" variant="outline" size="sm" onClick={save}>
              {t("save")}
            </Button>
          )}
        </div>
      </form>
    </aside>
  );
}

function NumberField({
  label,
  name,
  value,
  placeholder,
}: {
  label: string;
  name: string;
  value?: number | null;
  placeholder: string;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        {label}
      </span>
      <input
        type="number"
        name={name}
        min={1}
        step={1}
        inputMode="numeric"
        placeholder={placeholder}
        defaultValue={value ?? ""}
        // Число застосовуємо після введення, а не на кожну цифру.
        onChange={(e) => e.stopPropagation()}
        onBlur={(e) => e.currentTarget.form?.requestSubmit()}
        className={cn(SELECT_CLASS, "h-9 cursor-text")}
      />
    </label>
  );
}

export function Group({
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

export function Choice({
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

const HOURS = Array.from({ length: 24 }, (_, h) => h);

/**
 * Час вильоту чи прильоту: частини доби (місцевий час аеропорту) або власний діапазон
 * «з … до …» (через північ теж можна: 22 → 5). Поля `<name>hFrom`/`<name>hTo` — для форми без JS.
 */
function TimeGroup({
  legend,
  name,
  periods,
  hours,
}: {
  legend: string;
  name: string;
  periods?: DeparturePeriod[];
  hours?: HourRange | null;
}) {
  const t = useTranslations("filters");
  return (
    <Group legend={legend}>
      {DEPARTURE_PERIODS.map((period) => (
        <Choice
          key={period}
          type="checkbox"
          name={name}
          value={period}
          checked={periods?.includes(period) ?? false}
          label={t(`period.${period}`)}
        />
      ))}
      <div className="text-muted-foreground mt-1 flex items-center gap-2 text-xs">
        <span>{t("customHours")}</span>
        <select
          name={`${name}hFrom`}
          aria-label={t("hoursFrom", { legend })}
          defaultValue={hours?.start ?? ""}
          className={cn(SELECT_CLASS, "h-8 w-16 px-1.5 text-xs")}
        >
          <option value="">—</option>
          {HOURS.map((h) => (
            <option key={h} value={h}>
              {String(h).padStart(2, "0")}
            </option>
          ))}
        </select>
        <span>–</span>
        <select
          name={`${name}hTo`}
          aria-label={t("hoursTo", { legend })}
          defaultValue={hours?.end ?? ""}
          className={cn(SELECT_CLASS, "h-8 w-16 px-1.5 text-xs")}
        >
          <option value="">—</option>
          {HOURS.map((h) => (
            <option key={h + 1} value={h + 1}>
              {String(h + 1).padStart(2, "0")}
            </option>
          ))}
        </select>
      </div>
    </Group>
  );
}

function OptionSelect({
  label,
  hint,
  name,
  value,
  options,
  any,
  format,
}: {
  label: string;
  hint?: string;
  name: string;
  value?: number | null;
  options: readonly number[];
  any: string;
  format: (n: number) => string;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        {label}
      </span>
      <select name={name} defaultValue={value ?? ""} className={cn(SELECT_CLASS, "h-9")}>
        <option value="">{any}</option>
        {options.map((n) => (
          <option key={n} value={n}>
            {format(n)}
          </option>
        ))}
      </select>
      {hint && <span className="text-muted-foreground text-[11px]">{hint}</span>}
    </label>
  );
}
