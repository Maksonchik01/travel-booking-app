"use client";

import type { Amenity, StayFacets, StayFilters as Filters } from "@tickets/shared";
import { ChevronDown } from "lucide-react";
import Form from "next/form";
import { useTranslations } from "next-intl";
import Link from "next/link";

import { FormPendingNote } from "@/components/pending";
import { Choice, Group, NumberField, OptionSelect } from "@/components/result-filters";
import { FilterShell, SheetActions } from "@/components/filter-shell";
import { Button } from "@/components/ui/button";
import {
  MAX_DISTANCE_OPTIONS,
  MIN_BEDS_OPTIONS,
  MIN_RATING_OPTIONS,
  RADIUS_OPTIONS,
  stayFilterParams,
} from "@/lib/stay-params";
import { SELECT_CLASS } from "@/lib/styles";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";

type StayData = NonNullable<StayFacets["available"]>[number];

type Props = {
  filters: Filters;
  facets: StayFacets;
  /** Аеропорти міста — для «біля аеропорту». */
  airports?: string[];
  currency?: string;
  /** Решта стану пошуку (місто, дати, сортування) — щоб фільтр його не губив. */
  baseParams: [string, string][];
};

/**
 * Фільтри житла: GET-форма (без JS — кнопка «Застосувати»), з JS застосовується одразу.
 * Нового запиту до провайдерів не робить — фільтрує бекенд після них.
 */
export function StayFilters({
  filters,
  facets,
  baseParams,
  airports = [],
  currency = "EUR",
}: Props) {
  const t = useTranslations("stayFilters");
  const tKind = useTranslations("stayCard.kind");
  const tShared = useTranslations("filters");
  const tAmenity = useTranslations("stayCard.amenity");
  // Лише фільтри, для яких у видачі є дані (модуль 5): немає даних — фільтра немає.
  const available = new Set(facets.available ?? []);
  const has = (key: StayData) => available.has(key);
  const conditions: [string, string, boolean][] = [
    ...(has("cancellation")
      ? [
          ["cancel", t("freeCancellation"), !!filters.free_cancellation] as [
            string,
            string,
            boolean,
          ],
        ]
      : []),
    ...(has("breakfast")
      ? [["bfast", t("breakfast"), !!filters.breakfast_included] as [string, string, boolean]]
      : []),
    ...(has("prepayment")
      ? [["noprepay", t("noPrepayment"), !!filters.no_prepayment] as [string, string, boolean]]
      : []),
    ...(has("pay_at_property")
      ? [["payprop", t("payAtProperty"), !!filters.pay_at_property] as [string, string, boolean]]
      : []),
  ];
  const advancedAvailable =
    (facets.amenities?.length ?? 0) > 0 ||
    has("beds") ||
    has("distance") ||
    has("district") ||
    (has("coordinates") && airports.length > 0);
  const advancedActive = Boolean(
    filters.amenities?.length ||
    filters.min_beds ||
    filters.max_distance_center_km ||
    filters.districts?.length ||
    filters.near_airport ||
    filters.near ||
    filters.radius_km,
  );
  const hydrated = useHydrated();
  const activeCount = stayFilterParams(filters).length;
  const resetHref = `/stays?${new URLSearchParams(baseParams)}`;

  return (
    <FilterShell titleId="stay-filters-title" count={activeCount} testId="stay-filters">
      {({ sheet, close }) => (
        <Form
          action="/stays"
          data-track="filters_applied"
          data-track-mode="stays"
          id="stay-filters-panel"
          className="grid gap-5 text-sm"
          onSubmit={close}
          // Десктоп — одразу; у вікні на телефоні — кнопкою «Застосувати».
          onChange={sheet ? undefined : (e) => e.currentTarget.requestSubmit()}
        >
          {baseParams.map(([key, value]) => (
            <input key={`${key}=${value}`} type="hidden" name={key} value={value} />
          ))}

          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label={t("minPrice", { currency })}
              name="minp"
              value={filters.min_price_per_night}
              placeholder={tShared("anyPrice")}
            />
            <NumberField
              label={t("maxPrice", { currency })}
              name="maxp"
              value={filters.max_price_per_night}
              placeholder={tShared("anyPrice")}
            />
            <NumberField
              label={t("minTotal", { currency })}
              name="mint"
              value={filters.min_total_price}
              placeholder={tShared("anyPrice")}
            />
            <NumberField
              label={t("maxTotal", { currency })}
              name="maxt"
              value={filters.max_total_price}
              placeholder={tShared("anyPrice")}
            />
          </div>

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

          {has("rating") && (
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
          )}

          {conditions.length > 0 && (
            <Group legend={t("conditions")} hint={t("conditionsHint")}>
              {conditions.map(([name, label, checked]) => (
                <Choice
                  key={name}
                  type="checkbox"
                  name={name}
                  value="1"
                  checked={checked}
                  label={label}
                />
              ))}
            </Group>
          )}

          {advancedAvailable && (
            <details className="group grid gap-5" open={advancedActive}>
              <summary className="text-primary flex cursor-pointer list-none items-center gap-1.5 text-xs font-semibold tracking-wide uppercase [&::-webkit-details-marker]:hidden">
                {tShared("advanced")}
                <ChevronDown
                  className="size-3.5 transition-transform group-open:rotate-180"
                  aria-hidden
                />
              </summary>
              <div className="mt-4 grid gap-5">
                {facets.amenities && facets.amenities.length > 0 && (
                  <Group legend={t("amenities")} hint={t("amenitiesHint")}>
                    {facets.amenities.map((a) => (
                      <Choice
                        key={a.value}
                        type="checkbox"
                        name="am"
                        value={a.value}
                        checked={filters.amenities?.includes(a.value as Amenity) ?? false}
                        label={tAmenity(a.value as Amenity)}
                        count={a.stays}
                      />
                    ))}
                  </Group>
                )}
                {has("beds") && (
                  <OptionSelect
                    label={t("beds")}
                    name="beds"
                    value={filters.min_beds}
                    options={MIN_BEDS_OPTIONS}
                    any={t("any")}
                    format={(n) => t("bedsFrom", { count: n })}
                  />
                )}
                {has("distance") && (
                  <OptionSelect
                    label={t("distance")}
                    name="dist"
                    value={filters.max_distance_center_km}
                    options={MAX_DISTANCE_OPTIONS}
                    any={t("any")}
                    format={(km) => t("upToKm", { km })}
                  />
                )}
                {has("district") && facets.districts && facets.districts.length > 1 && (
                  <Group legend={t("district")}>
                    {facets.districts.map((d) => (
                      <Choice
                        key={d.value}
                        type="checkbox"
                        name="district"
                        value={d.value}
                        checked={filters.districts?.includes(d.value) ?? false}
                        label={d.value}
                        count={d.stays}
                      />
                    ))}
                  </Group>
                )}
                {has("coordinates") && airports.length > 0 && (
                  <div className="grid gap-2">
                    <label className="grid gap-1.5">
                      <span className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                        {t("nearAirport")}
                      </span>
                      <select
                        name="nearap"
                        defaultValue={filters.near_airport ?? ""}
                        className={cn(SELECT_CLASS, "h-9")}
                      >
                        <option value="">{t("any")}</option>
                        {airports.map((code) => (
                          <option key={code} value={code}>
                            {code}
                          </option>
                        ))}
                      </select>
                    </label>
                    <OptionSelect
                      label={t("radius")}
                      name="radius"
                      value={filters.radius_km}
                      options={RADIUS_OPTIONS}
                      any={t("any")}
                      format={(km) => t("upToKm", { km })}
                    />
                  </div>
                )}
                {filters.near && (
                  <input
                    type="hidden"
                    name="near"
                    value={`${filters.near.lat},${filters.near.lon}`}
                  />
                )}
              </div>
            </details>
          )}

          <FormPendingNote label={tShared("updating")} className="min-h-4" />

          <SheetActions sheet={sheet}>
            {(!hydrated || sheet) && (
              <Button
                type="submit"
                size={sheet ? "default" : "sm"}
                className={cn(sheet && "flex-1")}
              >
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
          </SheetActions>
        </Form>
      )}
    </FilterShell>
  );
}
